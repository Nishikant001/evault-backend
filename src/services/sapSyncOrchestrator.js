// src/services/sapSyncOrchestrator.js
//
// Single entry point used by BOTH sapSyncController (manual REST triggers)
// and sapSyncScheduler (cron-driven scheduled/retry triggers), so the
// "open a SapSyncLog -> run the sync -> close the SapSyncLog" lifecycle
// only lives in one place.
//
// CONCURRENCY GUARD:
// withTenantLock() below prevents two sync runs (master/document/retry,
// manual/scheduled — any combination) from executing for the SAME tenant
// at the same time in this process. Overlapping runs against the same
// tenant's rows is the main way the per-record transactions in
// sapMasterSyncService.js / sapDocumentSyncService.js end up fighting
// each other for locks and raising ER_LOCK_DEADLOCK. This is an
// in-process guard (a plain Set), which is sufficient for a single
// Node process; if this app is ever run with multiple instances/workers
// behind a load balancer, this should be swapped for a DB-backed or
// Redis-backed lock instead.

const SapSyncLogService = require("./sapSyncLogService");
const MasterSyncService = require("./sapMasterSyncService");
const DocumentSyncService = require("./sapDocumentSyncService");
const RetryQueueService = require("./sapRetryQueueService");
// PHASE G — Tenant/ErpConfig are Master DB models. Category/DocumentType/
// Document (used further below) are tenant-side, resolved per-call via
// getTenantConnection(tenantId) instead of a static legacy import.
const masterModels = require("../models/masterDb");
const { getTenantConnection } = require("./tenantConnectionManager");
const {
  SAP_SYNC_TYPE,
  SAP_SYNC_ENTITY_TYPE,
} = require("../constants/sapSyncConstants");

// tenantId currently mid-sync (any job type) -> true
const runningTenants = new Set();

async function withTenantLock(tenantId, fn) {
  if (runningTenants.has(tenantId)) {
    throw new Error(
      `A SAP sync is already running for tenant ${tenantId} — please wait for it to finish before starting another`,
    );
  }
  runningTenants.add(tenantId);
  try {
    return await fn();
  } finally {
    runningTenants.delete(tenantId);
  }
}

async function runMasterSync({ tenantId, triggerType, triggeredBy }) {
  return withTenantLock(tenantId, async () => {
    console.log("STEP-1");

    const tenant = await masterModels.Tenant.findByPk(tenantId, { include: [{ model: masterModels.ErpConfig }] });
    console.log("STEP-2", tenant);

    const logRow = await SapSyncLogService.startLog({
      tenantId,
      erpConfigId: tenant?.ErpConfig?.id,
      syncType: SAP_SYNC_TYPE.MASTER,
      triggerType,
      triggeredBy,
    });
    console.log("STEP-3");
    try {
      const result = await MasterSyncService.syncMasters({
        tenantId,
        sapSyncLogId: logRow.id,
      });

      console.log("SYNC RESULT:", result);

      await SapSyncLogService.finishLog(logRow, result);
      return { logId: logRow.id, ...result };
    } catch (error) {
      console.error("=========== MASTER SYNC ERROR ===========");
      console.error(error);
      console.error(error.stack);

      await SapSyncLogService.failLog(logRow, error);
      throw error;
    }
  });
}

async function runDocumentSync({ tenantId, triggerType, triggeredBy }) {
  return withTenantLock(tenantId, async () => {
    const tenant = await masterModels.Tenant.findByPk(tenantId, { include: [{ model: masterModels.ErpConfig }] });
    const logRow = await SapSyncLogService.startLog({
      tenantId,
      erpConfigId: tenant?.ErpConfig?.id,
      syncType: SAP_SYNC_TYPE.DOCUMENT,
      triggerType,
      triggeredBy,
    });

    try {
      const result = await DocumentSyncService.syncDocuments({ tenantId, sapSyncLogId: logRow.id });
      await SapSyncLogService.finishLog(logRow, result);
      return { logId: logRow.id, ...result };
    } catch (error) {
      await SapSyncLogService.failLog(logRow, error);
      throw error;
    }
  });
}

/**
 * Picks the correct "re-attempt this one record" function for a Retry
 * Queue row based on its entityType.
 */
function retryFnFor(entityType, tenantId) {
  switch (entityType) {
    case SAP_SYNC_ENTITY_TYPE.DEPARTMENT:
      return async (mapped) => {
        // Department is shared/global Master DB data (no tenantId column
        // at all — see PHASE_F_MIGRATION_REPORT.md section 1).
        const { Department } = masterModels;
        const existing = await Department.findOne({ where: { sapCode: mapped.code } });
        if (existing) {
          await existing.update({ name: mapped.name, description: mapped.description, status: mapped.status, lastSyncedAt: new Date() });
        } else {
          await Department.create({
            name: mapped.name,
            code: mapped.code.toUpperCase().slice(0, 50),
            description: mapped.description,
            status: mapped.status,
            sapCode: mapped.code,
            lastSyncedAt: new Date(),
          });
        }
      };
    case SAP_SYNC_ENTITY_TYPE.CATEGORY:
      return async (mapped) => {
        const { Department, TenantDepartment } = masterModels;
        const { models: tenantModels } = await getTenantConnection(tenantId);
        const { Category } = tenantModels;
        const department = await Department.findOne({ where: { sapCode: mapped.departmentCode } });
        if (!department) throw new Error(`Parent Department with sapCode "${mapped.departmentCode}" still not found`);
        await TenantDepartment.findOrCreate({
          where: { tenantId, departmentId: department.id },
          defaults: { tenantId, departmentId: department.id, status: "ACTIVE" },
        });
        const existing = await Category.findOne({ where: { sapCode: mapped.code } });
        if (existing) {
          await existing.update({ name: mapped.name, departmentId: department.id, description: mapped.description, status: mapped.status, lastSyncedAt: new Date() });
        } else {
          await Category.create({ tenantId, departmentId: department.id, name: mapped.name, description: mapped.description, status: mapped.status, sapCode: mapped.code, lastSyncedAt: new Date() });
        }
      };
    case SAP_SYNC_ENTITY_TYPE.DOCUMENT_TYPE:
      return async (mapped) => {
        const { models: tenantModels } = await getTenantConnection(tenantId);
        const { Category, DocumentType } = tenantModels;
        const category = await Category.findOne({ where: { sapCode: mapped.categoryCode } });
        if (!category) throw new Error(`Parent Category with sapCode "${mapped.categoryCode}" still not found`);
        const existing = await DocumentType.findOne({ where: { sapCode: mapped.code } });
        if (existing) {
          await existing.update({ name: mapped.name, categoryId: category.id, description: mapped.description, status: mapped.status, lastSyncedAt: new Date() });
        } else {
          await DocumentType.create({ tenantId, categoryId: category.id, name: mapped.name, description: mapped.description, status: mapped.status, sapCode: mapped.code, lastSyncedAt: new Date() });
        }
      };
    case SAP_SYNC_ENTITY_TYPE.DOCUMENT:
      return async (mapped) => {
        await DocumentSyncService.retryDocumentRecord(tenantId, mapped);
      };
    default:
      return async () => {
        throw new Error(`Unknown retry entityType: ${entityType}`);
      };
  }
}

/**
 * Processes every due Retry Queue item for a tenant (optionally scoped to
 * one entityType). Groups by entityType internally since each type needs
 * a different retry function.
 */
async function runRetry({ tenantId, entityType, triggerType, triggeredBy }) {
  return withTenantLock(tenantId, async () => {
    const tenant = await masterModels.Tenant.findByPk(tenantId, { include: [{ model: masterModels.ErpConfig }] });
    const logRow = await SapSyncLogService.startLog({
      tenantId,
      erpConfigId: tenant?.ErpConfig?.id,
      syncType: entityType === SAP_SYNC_ENTITY_TYPE.DOCUMENT ? SAP_SYNC_TYPE.DOCUMENT : SAP_SYNC_TYPE.MASTER,
      triggerType: triggerType || "RETRY",
      triggeredBy,
    });

    try {
      const entityTypes = entityType
        ? [entityType]
        : [
            SAP_SYNC_ENTITY_TYPE.DEPARTMENT,
            SAP_SYNC_ENTITY_TYPE.CATEGORY,
            SAP_SYNC_ENTITY_TYPE.DOCUMENT_TYPE,
            SAP_SYNC_ENTITY_TYPE.DOCUMENT,
          ];

      let resolved = 0;
      let stillFailing = 0;
      let processed = 0;

      for (const type of entityTypes) {
        const outcome = await RetryQueueService.processDueItems({
          tenantId,
          entityType: type,
          retryFn: retryFnFor(type, tenantId),
        });
        resolved += outcome.resolved;
        stillFailing += outcome.stillFailing;
        processed += outcome.processed;
      }

      const result = {
        recordsFetched: processed,
        recordsCreated: resolved,
        recordsUpdated: 0,
        recordsFailed: stillFailing,
        summary: { retried: processed, resolved, stillFailing },
        errors: [],
      };
      await SapSyncLogService.finishLog(logRow, result);
      return { logId: logRow.id, ...result };
    } catch (error) {
      await SapSyncLogService.failLog(logRow, error);
      throw error;
    }
  });
}

module.exports = { runMasterSync, runDocumentSync, runRetry };