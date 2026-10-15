// src/services/sapMasterSyncService.js
//
// SAP Master Synchronization.
//
// Sync order (parent before child, per the brief): DepartmentSet ↓
// CategorySet ↓ DocumentTypeSet. Each entity set is synced independently
// and idempotently — matched/upserted by its SAP code, never duplicated.
//
// Department is the GLOBAL master (see models/Department.js) — it is
// upserted once per run regardless of tenant. Category and DocumentType are
// TENANT-SCOPED (see models/Category.js / DocumentType.js), so they are
// synced for the ONE tenant whose ErpConfig is driving this run; the
// (tenantId, sapCode) unique indexes added to those models guarantee no
// duplicates even if the same run is triggered twice concurrently.
//
// Every individual record is written in its own small transaction so one
// bad row (e.g. a CategorySet row whose DepartmentCode doesn't exist yet)
// never rolls back the rows around it — it is logged and pushed onto the
// Retry Queue instead, and the run continues.
//
// DEADLOCK HANDLING:
// Each per-record transaction is wrapped in withDeadlockRetry(). Under
// concurrent load (two sync runs for related tenants, a retry sweep
// overlapping a scheduled run, etc.) MySQL/InnoDB can report
// ER_LOCK_DEADLOCK on these short read-then-write transactions — that is
// expected, recoverable behavior, not a data problem. withDeadlockRetry
// re-runs the whole transaction a few times with a short backoff before
// giving up and falling through to the existing Retry Queue path below.
const { Op } = require("sequelize");
const {
  masterSequelize,
  Tenant,
  ErpConfig,
  TenantErpConnection,
  Department,
  TenantDepartment,
} = require("../models/masterDb");

const { getTenantConnection } = require("./tenantConnectionManager");
const SapService = require("./sapService");
const RetryQueueService = require("./sapRetryQueueService");
const withDeadlockRetry = require("../utils/withDeadlockRetry");
const {
  mapDepartment,
  mapCategory,
  mapDocumentType,
} = require("./sapSyncFieldMap");
const { SAP_SYNC_ENTITY_TYPE } = require("../constants/sapSyncConstants");
const { resolveEntitySet } = require("./sapEntityResolver");

// ── Global Department-sync mutex ────────────────────────────
// Department is the GLOBAL master (see comment above / models/Department.js)
// — every tenant's Master Sync writes to the SAME rows. sapSyncOrchestrator's
// withTenantLock() only prevents ONE tenant from running two syncs at once;
// it does nothing to stop tenant A's syncDepartments() and tenant B's
// syncDepartments() from running concurrently and fighting over the same
// department rows, which is exactly what produces the deadlocks that keep
// recurring across all withDeadlockRetry attempts (both sides keep retrying
// at the same time). This is a simple in-process promise chain: it forces
// every call to runDepartmentSyncSerialized() to wait for the previous one
// to finish (success OR failure) before starting, regardless of which
// tenant it belongs to. Like withTenantLock, this is process-local — if
// this app is ever scaled to multiple Node instances, swap this for a
// DB-backed or Redis-backed lock instead.
let departmentSyncChain = Promise.resolve();

function runDepartmentSyncSerialized(fn) {
  const run = departmentSyncChain.then(fn, fn);
  // Swallow the error on the *chain* itself (so one tenant's failure
  // doesn't wedge the queue for the next tenant) — the real error is
  // still returned/thrown to this call's own caller via `run`.
  departmentSyncChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Resolves the ErpConfig for a tenant, enforcing it is a SAP config (this
 * module is SAP-specific per the brief's title). Throws a clear error
 * otherwise — mirrors the getErpConfigForTenant helper already used by
 * documentController.js / sapFinalizationService.js.
 *
 * PHASE 2 (multi-ERP sync) — `erpConfigId` is optional and, when passed,
 * lets a tenant with more than one ERP connection pick which one to sync.
 * Resolution order:
 *
 *  1. erpConfigId explicitly given -> it MUST be one of this tenant's own
 *     ACTIVE TenantErpConnection rows (tenant-isolation check — a tenant
 *     can never sync another tenant's ERP just by passing its id) and it
 *     MUST be erpType SAP.
 *  2. No erpConfigId given, tenant has exactly ONE active SAP connection
 *     in TenantErpConnection -> use it. This is what makes existing
 *     single-ERP tenants keep working unchanged after the Phase 1
 *     migration backfilled tenant_erp_connections for every tenant that
 *     already had a legacy erpConfigId.
 *  3. No erpConfigId given, tenant has MULTIPLE active SAP connections ->
 *     there is no per-connection "default" flag in the schema yet, so
 *     rather than guessing, this throws and asks the caller to pass
 *     erpConfigId explicitly (see TENANT_MULTI_ERP_CONNECTIONS.md).
 *  4. No TenantErpConnection rows at all (tenant predates Phase 1 / was
 *     never migrated) -> fall back to the legacy tenant.ErpConfig lookup,
 *     exactly as before.
 */
async function getSapErpConfigForTenant(tenantId, erpConfigId) {
  if (erpConfigId) {
    const connection = await TenantErpConnection.findOne({
      where: { tenantId, erpConfigId, isActive: true },
      include: [{ model: ErpConfig, as: "erpConfig" }],
    });
    if (!connection || !connection.erpConfig) {
      throw new Error("Requested ERP configuration is not assigned to this tenant");
    }
    if (connection.erpConfig.erpType !== "SAP") {
      throw new Error(
        `Requested ERP configuration is of type ${connection.erpConfig.erpType}; SAP Master Synchronization only supports SAP`,
      );
    }
    return connection.erpConfig;
  }

  const activeSapConnections = await TenantErpConnection.findAll({
    where: { tenantId, isActive: true },
    include: [{ model: ErpConfig, as: "erpConfig", where: { erpType: "SAP" }, required: true }],
  });

  if (activeSapConnections.length === 1) {
    return activeSapConnections[0].erpConfig;
  }
  if (activeSapConnections.length > 1) {
    throw new Error(
      "Tenant has multiple active SAP ERP connections; please specify erpConfigId",
    );
  }

  // No TenantErpConnection rows yet for this tenant — legacy fallback.
  const tenant = await Tenant.findByPk(tenantId, {
    include: [{ model: ErpConfig }],
  });
  if (!tenant || !tenant.ErpConfig) {
    throw new Error("ERP configuration not assigned to tenant");
  }
  if (tenant.ErpConfig.erpType !== "SAP") {
    throw new Error(
      `Tenant's ERP configuration is of type ${tenant.ErpConfig.erpType}; SAP Master Synchronization only supports SAP`,
    );
  }
  return tenant.ErpConfig;
}

// ── DepartmentSet ────────────────────────────────────────────
async function syncDepartments(erpConfig, { sapSyncLogId, tenantId } = {}) {
  const raw = await SapService.fetchEntitySet(
    erpConfig,
    resolveEntitySet(erpConfig, "DEPARTMENT"),
  );
  const counters = { fetched: raw.length, created: 0, updated: 0, failed: 0 };
  const errors = [];

  for (const rec of raw) {
    const mapped = mapDepartment(rec, erpConfig);
    if (!mapped.code || !mapped.name) {
      counters.failed += 1;
      errors.push({
        entityType: "DEPARTMENT",
        code: mapped.code || "UNKNOWN",
        message: "Missing DepartmentCode or DepartmentName",
        timestamp: new Date(),
      });
      await RetryQueueService.enqueue({
        tenantId,
        erpConfigId: erpConfig.id, // MULTI-ERP FIX
        entityType: SAP_SYNC_ENTITY_TYPE.DEPARTMENT,
        referenceCode:
          mapped.code || `UNKNOWN_${JSON.stringify(rec).slice(0, 40)}`,
        payload: mapped,
        error: new Error("Missing DepartmentCode or DepartmentName"),
        sapSyncLogId,
      });
      continue;
    }

    try {
      await withDeadlockRetry(() =>
        masterSequelize.transaction(async (t) => {
          // Try the idempotency key (sapCode) first — this is the single
          // most selective lookup and keeps the locked index range as
          // narrow as possible. Only fall back to the looser code/name
          // match (covers legacy rows created before sapCode existed)
          // when the sapCode lookup misses.
          let existing = await Department.findOne({
            where: { sapCode: mapped.code },
            transaction: t,
          });

          if (!existing) {
            existing = await Department.findOne({
              where: {
                [Op.or]: [
                  { code: mapped.code.toUpperCase().slice(0, 50) },
                  { name: mapped.name },
                ],
              },
              transaction: t,
            });
          }

          let department;

          if (existing) {
            console.log("Department ID :", existing.id);
            console.log("Department Code :", existing.sapCode);
            console.log("Before Update");

            await existing.update(
              {
                sapCode: mapped.code,
                name: mapped.name,
                description: mapped.description,
                status: mapped.status,
                lastSyncedAt: new Date(),
              },
              { transaction: t },
            );

            department = existing;

            console.log("After Update");
            counters.updated += 1;
          } else {
            console.log("Creating Department =>", {
              name: mapped.name,
              code: mapped.code.toUpperCase().slice(0, 50),
              description: mapped.description,
              status: mapped.status,
              sapCode: mapped.code,
            });

            department = await Department.create(
              {
                name: mapped.name,
                code: mapped.code.toUpperCase().slice(0, 50),
                description: mapped.description,
                status: mapped.status,
                sapCode: mapped.code,
                lastSyncedAt: new Date(),
              },
              { transaction: t },
            );

            counters.created += 1;
          }
          const existingTenantDepartment = await TenantDepartment.findOne({
            where: {
              tenantId,
              departmentId: department.id,
            },
            transaction: t,
          });

          if (!existingTenantDepartment) {
            await TenantDepartment.create(
              {
                tenantId,
                departmentId: department.id,
                status: "ACTIVE",
                                erpConfigId: erpConfig.id,          // ← ADD

              },
              { transaction: t },
            );
          } else if (existingTenantDepartment.status !== "ACTIVE") {
            await existingTenantDepartment.update(
              { status: "ACTIVE", erpConfigId: erpConfig.id  },
              { transaction: t },
            );
          }
        }),
      );
    } catch (error) {
      console.error("========== ERROR ==========");
      console.log("SQL =", error.parent?.sql);
      console.log("CODE =", error.parent?.code);
      console.log("MESSAGE =", error.parent?.sqlMessage);
      console.error(error);
      console.error(error.parent);
      console.error(error.sql);

      console.log("========== DEPARTMENT ERROR ==========");
      console.log("SAP Record :", rec);
      console.log("Mapped :", mapped);
      console.error(error);

      if (error.errors) {
        console.error(error.errors);
      }

      counters.failed += 1;
      errors.push({
        entityType: "DEPARTMENT",
        code: mapped.code,
        message: error.message,
        timestamp: new Date(),
      });

      await RetryQueueService.enqueue({
        tenantId,
        erpConfigId: erpConfig.id, // MULTI-ERP FIX
        entityType: SAP_SYNC_ENTITY_TYPE.DEPARTMENT,
        referenceCode: mapped.code,
        payload: mapped,
        error,
        sapSyncLogId,
      });
    }
  }

  return { counters, errors };
}

// ── CategorySet ──────────────────────────────────────────────
// ── CategorySet ──────────────────────────────────────────────
async function syncCategories(erpConfig, { sapSyncLogId, tenantId }) {
  const raw = await SapService.fetchEntitySet(
    erpConfig,
    resolveEntitySet(erpConfig, "CATEGORY"),
  );
  const counters = { fetched: raw.length, created: 0, updated: 0, failed: 0 };
  const errors = [];

  const { sequelize: tenantSequelize, models: tenantModels } = await getTenantConnection(tenantId);
  const { Category } = tenantModels;

  for (const rec of raw) {
    const mapped = mapCategory(rec, erpConfig);
    try {
      if (!mapped.code || !mapped.name || !mapped.departmentCode) {
        throw new Error(
          "Missing CategoryCode, CategoryName, or DepartmentCode",
        );
      }

      const department = await Department.findOne({
        where: { sapCode: mapped.departmentCode },
      });
      if (!department) {
        throw new Error(
          `Parent Department with sapCode "${mapped.departmentCode}" not found — sync DepartmentSet first`,
        );
      }

      // TenantDepartment lives in the MASTER DB — its own transaction.
      await withDeadlockRetry(() =>
        masterSequelize.transaction(async (t) => {
          let tenantDept = await TenantDepartment.findOne({
            where: {
              tenantId,
              departmentId: department.id,
            },
            transaction: t,
          });

          if (!tenantDept) {
            tenantDept = await TenantDepartment.create(
              {
                tenantId,
                departmentId: department.id,
                status: "ACTIVE",
              },
              { transaction: t },
            );
          } else if (tenantDept.status !== "ACTIVE") {
            await tenantDept.update({ status: "ACTIVE" }, { transaction: t });
          }
        }),
      );

      // Category lives in THIS TENANT's own DB — separate transaction.
      await withDeadlockRetry(() =>
        tenantSequelize.transaction(async (t) => {
          const existing = await Category.findOne({
            where: {
              tenantId,
              [Op.or]: [
                {
                  sapCode: mapped.code,
                },
                {
                  name: mapped.name,
                  departmentId: department.id,
                },
              ],
            },
            transaction: t,
          });

                   if (existing) {
            await existing.update(
              {
                name: mapped.name,
                departmentId: department.id,
                description: mapped.description,
                status: mapped.status,
                lastSyncedAt: new Date(),
                erpConfigId: erpConfig.id,
              },
              { transaction: t },
            );
            counters.updated += 1;
          } else {
            await Category.create(
              {
                tenantId,
                departmentId: department.id,
                name: mapped.name,
                description: mapped.description,
                status: mapped.status,
                sapCode: mapped.code,
                lastSyncedAt: new Date(),
                erpConfigId: erpConfig.id,
              },
              { transaction: t },
            );
            counters.created += 1;
          }
        }),
      );
    } catch (error) {
      console.error("========== ERROR ==========");
      console.log("SQL =", error.parent?.sql);
      console.log("CODE =", error.parent?.code);
      console.log("MESSAGE =", error.parent?.sqlMessage);
      console.error(error);
      console.error(error.parent);
      console.error(error.sql);
      counters.failed += 1;
      errors.push({
        entityType: "CATEGORY",
        code: mapped.code || "UNKNOWN",
        message: error.message,
        timestamp: new Date(),
      });
      await RetryQueueService.enqueue({
        tenantId,
        erpConfigId: erpConfig.id, // MULTI-ERP FIX
        entityType: SAP_SYNC_ENTITY_TYPE.CATEGORY,
        referenceCode:
          mapped.code || `UNKNOWN_${JSON.stringify(rec).slice(0, 40)}`,
        payload: mapped,
        error,
        sapSyncLogId,
      });
    }
  }

  return { counters, errors };
}

// ── DocumentTypeSet ──────────────────────────────────────────
async function syncDocumentTypes(erpConfig, { sapSyncLogId, tenantId }) {
  const raw = await SapService.fetchEntitySet(
    erpConfig,
    resolveEntitySet(erpConfig, "DOCUMENT_TYPE"),
  );
  const counters = { fetched: raw.length, created: 0, updated: 0, failed: 0 };
  const errors = [];

  const { sequelize: tenantSequelize, models: tenantModels } = await getTenantConnection(tenantId);
  const { Category, DocumentType } = tenantModels;

  for (const rec of raw) {
    const mapped = mapDocumentType(rec, erpConfig);
    try {
      if (!mapped.code || !mapped.name || !mapped.categoryCode) {
        throw new Error(
          "Missing DocumentTypeCode, DocumentTypeName, or CategoryCode",
        );
      }

      const category = await Category.findOne({
        where: { tenantId, sapCode: mapped.categoryCode },
      });
      if (!category) {
        throw new Error(
          `Parent Category with sapCode "${mapped.categoryCode}" not found for this tenant — sync CategorySet first`,
        );
      }

      await withDeadlockRetry(() =>
        tenantSequelize.transaction(async (t) => {
          const existing = await DocumentType.findOne({
            where: {
              tenantId,
              [Op.or]: [
                {
                  sapCode: mapped.code,
                },
                {
                  name: mapped.name,
                  categoryId: category.id,
                },
              ],
            },
            transaction: t,
          });

                   if (existing) {
            await existing.update(
              {
                name: mapped.name,
                categoryId: category.id,
                description: mapped.description,
                status: mapped.status,
                lastSyncedAt: new Date(),
                erpConfigId: erpConfig.id,
              },
              { transaction: t },
            );
            counters.updated += 1;
          } else {
            await DocumentType.create(
              {
                tenantId,
                categoryId: category.id,
                name: mapped.name,
                description: mapped.description,
                status: mapped.status,
                sapCode: mapped.code,
                lastSyncedAt: new Date(),
                erpConfigId: erpConfig.id,
              },
              { transaction: t },
            );
            counters.created += 1;
          }
        }),
      );
    } catch (error) {
      console.error("========== ERROR ==========");
      console.log("SQL =", error.parent?.sql);
      console.log("CODE =", error.parent?.code);
      console.log("MESSAGE =", error.parent?.sqlMessage);
      console.error(error);
      console.error(error.parent);
      console.error(error.sql);
      counters.failed += 1;
      errors.push({
        entityType: "DOCUMENT_TYPE",
        code: mapped.code || "UNKNOWN",
        message: error.message,
        timestamp: new Date(),
      });
      await RetryQueueService.enqueue({
        tenantId,
        erpConfigId: erpConfig.id, // MULTI-ERP FIX
        entityType: SAP_SYNC_ENTITY_TYPE.DOCUMENT_TYPE,
        referenceCode:
          mapped.code || `UNKNOWN_${JSON.stringify(rec).slice(0, 40)}`,
        payload: mapped,
        error,
        sapSyncLogId,
      });
    }
  }

  return { counters, errors };
}

/**
 * Runs the full DepartmentSet -> CategorySet -> DocumentTypeSet sync, in
 * that order, for one tenant. Returns the combined counters/summary the
 * caller (sapSyncController / scheduler) writes into the SapSyncLog row.
 */
async function syncMasters({ tenantId, sapSyncLogId, erpConfigId }) {
  const erpConfig = await getSapErpConfigForTenant(tenantId, erpConfigId);

  // Department is global — serialize it across ALL tenants (see the
  // "Global Department-sync mutex" comment above) so two tenants'
  // Master Syncs never write to the same Department rows concurrently.
  const deptResult = await runDepartmentSyncSerialized(() =>
    syncDepartments(erpConfig, {
      tenantId,
      sapSyncLogId,
    }),
  );
  const catResult = await syncCategories(erpConfig, { tenantId, sapSyncLogId });
  const typeResult = await syncDocumentTypes(erpConfig, {
    tenantId,
    sapSyncLogId,
  });

  const summary = {
    DEPARTMENT: deptResult.counters,
    CATEGORY: catResult.counters,
    DOCUMENT_TYPE: typeResult.counters,
  };
  const errors = [
    ...deptResult.errors,
    ...catResult.errors,
    ...typeResult.errors,
  ];

  return {
    recordsFetched:
      deptResult.counters.fetched +
      catResult.counters.fetched +
      typeResult.counters.fetched,
    recordsCreated:
      deptResult.counters.created +
      catResult.counters.created +
      typeResult.counters.created,
    recordsUpdated:
      deptResult.counters.updated +
      catResult.counters.updated +
      typeResult.counters.updated,
    recordsFailed:
      deptResult.counters.failed +
      catResult.counters.failed +
      typeResult.counters.failed,
    summary,
    errors,
    // Which ErpConfig actually drove this run — orchestrator uses this to
    // stamp the SapSyncLog row correctly even when erpConfigId wasn't
    // passed in and this fell back to the tenant's single active SAP
    // connection / legacy tenant.ErpConfig.
    erpConfigId: erpConfig.id,
  };
}

module.exports = {
  getSapErpConfigForTenant,
  syncDepartments,
  syncCategories,
  syncDocumentTypes,
  syncMasters,
};