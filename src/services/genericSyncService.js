// src/services/genericSyncService.js
//
// Generic Master Synchronization for non-SAP ERP connections (Oracle,
// Custom, or any future erpType). Completes the Connector Engine pipeline
// the brief asks for:
//
//   ERP Connection -> Connector Config -> Authenticate -> Execute Request
//   -> Pagination -> Normalize -> Mapping -> Transformation -> Validation
//   -> Save -> Logging -> Retry
//
// (connectorEngine.js does everything through Validation; this file does
// Save / Logging / Retry, reusing the SAME SapSyncLog / SapSyncRetryQueue
// tables and sapRetryQueueService.js that SAP master sync already uses —
// erpConfigId-tagged rows are how a SAP failure and an Oracle failure for
// the same tenant stay completely separate, per the brief's isolation
// requirement, without inventing a second logging/retry system.
//
// Scope: CATEGORY and DOCUMENT_TYPE only (tenant-scoped master data).
// DEPARTMENT is deliberately out of scope here — it is GLOBAL data shared
// across every tenant with its own dedup/mutex rules (see the "Global
// Department-sync mutex" comment in sapMasterSyncService.js); reusing that
// safely for a second, independently-scheduled ERP source is a real piece
// of design work on its own, not something to bolt on quickly.
"use strict";

const { getTenantConnection } = require("./tenantConnectionManager");
const ConnectorEngine = require("./connector/connectorEngine");
const RetryQueueService = require("./sapRetryQueueService");

const SYNCABLE_ENTITIES = ["CATEGORY", "DOCUMENT_TYPE"];

async function startLog(tenantId, erpConfigId, entityName) {
  const { SapSyncLog } = (await getTenantConnection(tenantId)).models;
  return SapSyncLog.create({
    tenantId,
    erpConfigId,
    syncType: "MASTER",
    triggerType: "MANUAL",
    status: "RUNNING",
    startTime: new Date(),
  });
}

async function finishLog(log, { fetched, created, updated, failed, status }) {
  await log.update({
    endTime: new Date(),
    durationMs: Date.now() - new Date(log.startTime).getTime(),
    recordsFetched: fetched,
    recordsCreated: created,
    recordsUpdated: updated,
    recordsFailed: failed,
    status,
  });
}

/** Resolve a Category by its (tenantId, mapped.departmentCode -> departmentId, code). */
async function resolveDepartmentId(masterModels, tenantId, departmentCode) {
  if (!departmentCode) return null;
  const { Department, TenantDepartment } = masterModels;
  const dept = await Department.findOne({ where: { sapCode: departmentCode } });
  if (!dept) return null;
  const assignment = await TenantDepartment.findOne({ where: { tenantId, departmentId: dept.id, status: "ACTIVE" } });
  return assignment ? dept.id : null;
}

async function syncCategory({ tenantId, erpConfigId, masterModels, models, records }) {
  const { Category } = models;
  let created = 0, updated = 0, failed = 0;

  for (const rec of records) {
    if (rec.errors.length) {
      failed += 1;
      await RetryQueueService.enqueue({
        tenantId, erpConfigId, entityType: "CATEGORY",
        referenceCode: rec.mapped?.code || `unknown-${Date.now()}-${Math.random()}`,
        payload: rec.mapped || rec.raw,
        error: new Error(rec.errors.join("; ")),
      });
      continue;
    }
    try {
      const departmentId = await resolveDepartmentId(masterModels, tenantId, rec.mapped.departmentCode);
      if (!departmentId) throw new Error(`Department "${rec.mapped.departmentCode}" is not assigned to this tenant`);

      const [row, wasCreated] = await Category.findOrCreate({
        where: { tenantId, sapCode: rec.mapped.code },
        defaults: {
          tenantId,
          departmentId,
          name: rec.mapped.name,
          description: rec.mapped.description || null,
          sapCode: rec.mapped.code,
          erpConfigId,
          lastSyncedAt: new Date(),
        },
      });
      if (!wasCreated) {
        await row.update({
          departmentId,
          name: rec.mapped.name,
          description: rec.mapped.description ?? row.description,
          erpConfigId,
          lastSyncedAt: new Date(),
        });
        updated += 1;
      } else {
        created += 1;
      }
    } catch (err) {
      failed += 1;
      await RetryQueueService.enqueue({
        tenantId, erpConfigId, entityType: "CATEGORY",
        referenceCode: rec.mapped.code, payload: rec.mapped, error: err,
      });
    }
  }
  return { created, updated, failed };
}

async function syncDocumentType({ tenantId, erpConfigId, models, records }) {
  const { Category, DocumentType } = models;
  let created = 0, updated = 0, failed = 0;

  for (const rec of records) {
    if (rec.errors.length) {
      failed += 1;
      await RetryQueueService.enqueue({
        tenantId, erpConfigId, entityType: "DOCUMENT_TYPE",
        referenceCode: rec.mapped?.code || `unknown-${Date.now()}-${Math.random()}`,
        payload: rec.mapped || rec.raw,
        error: new Error(rec.errors.join("; ")),
      });
      continue;
    }
    try {
      const category = await Category.findOne({ where: { tenantId, sapCode: rec.mapped.categoryCode } });
      if (!category) throw new Error(`Category "${rec.mapped.categoryCode}" was not found for this tenant`);

      const [row, wasCreated] = await DocumentType.findOrCreate({
        where: { tenantId, sapCode: rec.mapped.code },
        defaults: {
          tenantId,
          categoryId: category.id,
          name: rec.mapped.name,
          description: rec.mapped.description || null,
          sapCode: rec.mapped.code,
          erpConfigId,
          lastSyncedAt: new Date(),
        },
      });
      if (!wasCreated) {
        await row.update({
          categoryId: category.id,
          name: rec.mapped.name,
          description: rec.mapped.description ?? row.description,
          erpConfigId,
          lastSyncedAt: new Date(),
        });
        updated += 1;
      } else {
        created += 1;
      }
    } catch (err) {
      failed += 1;
      await RetryQueueService.enqueue({
        tenantId, erpConfigId, entityType: "DOCUMENT_TYPE",
        referenceCode: rec.mapped.code, payload: rec.mapped, error: err,
      });
    }
  }
  return { created, updated, failed };
}

const SYNC_FN = { CATEGORY: syncCategory, DOCUMENT_TYPE: syncDocumentType };

/**
 * Sync one entity (CATEGORY or DOCUMENT_TYPE) for one non-SAP ERP
 * connection. Logs to SapSyncLog and queues failures on
 * SapSyncRetryQueue, both tagged with erpConfigId — never touches SAP's
 * own rows or SAP's own sync path.
 */
async function syncEntityForTenant(tenantId, erpConfig, entityName, masterModels) {
  if (erpConfig.erpType === "SAP") {
    throw new Error("genericSyncService is for non-SAP ERP connections — use SAP Master Synchronization for SAP.");
  }
  if (!SYNCABLE_ENTITIES.includes(entityName)) {
    throw new Error(`genericSyncService can sync ${SYNCABLE_ENTITIES.join(", ")} — not ${entityName} (DEPARTMENT sync for non-SAP ERPs is not implemented yet; DOCUMENT sync is available for read/preview via ErpFactory, not as a bulk master-sync run).`);
  }

  const log = await startLog(tenantId, erpConfig.id, entityName);
  try {
    const { fetched, records } = await ConnectorEngine.syncEntity(erpConfig, entityName);
    const { models } = await getTenantConnection(tenantId);
    const { created, updated, failed } = await SYNC_FN[entityName]({
      tenantId, erpConfigId: erpConfig.id, masterModels, models, records,
    });

    const status = failed === 0 ? "SUCCESS" : (created + updated > 0 ? "PARTIAL_SUCCESS" : "FAILED");
    await finishLog(log, { fetched, created, updated, failed, status });
    return { fetched, created, updated, failed, status, syncLogId: log.id };
  } catch (err) {
    await finishLog(log, { fetched: 0, created: 0, updated: 0, failed: 0, status: "FAILED" });
    throw err;
  }
}

module.exports = { syncEntityForTenant, SYNCABLE_ENTITIES };
