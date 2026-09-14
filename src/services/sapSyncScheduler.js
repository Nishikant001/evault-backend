// src/services/sapSyncScheduler.js
//
// Cron Scheduler for the SAP Master/Document Synchronization module.
// Supports the three modes required by the brief:
//   - Manual Sync    -> sapSyncController calls runMasterSync/runDocumentSync directly (no cron involved)
//   - Scheduled Sync -> this file's cron jobs, one per (tenant, job), driven by
//                        the SapSyncSchedule table so the Scheduler Management
//                        page can enable/disable and re-time each job per tenant
//   - Retry Failed Sync -> same mechanism, job = RETRY_SYNC
//
// PHASE G (brief STEP 6): SapSyncSchedule/ErpConfig are per-tenant data.
// "Every tenant job must explicitly resolve Master DB -> Tenant ->
// TenantDatabase -> Tenant Sequelize. No background job may use the old
// shared DB." start() now iterates every READY tenant from the Master DB
// and reads/writes that tenant's OWN SapSyncSchedule rows through its own
// connection (getTenantConnection — the same cache every HTTP request
// uses) — never a static top-level legacy model import.
//
// start() is called once from app.js after the Master DB connection is
// established. reload(tenantId, jobName) lets the Scheduler Management API
// re-register a single task immediately after an edit, without restarting
// the process. runJobNow(tenantId, jobName, userId) executes a job
// immediately regardless of its cron/enabled state (the "Run Now" button),
// and updates the schedule row's lastRunAt/lastRunStatus/lastDurationMs.

const cron = require("node-cron");
const masterModels = require("../models/masterDb");
const { getTenantConnection } = require("./tenantConnectionManager");
const Orchestrator = require("./sapSyncOrchestrator");
const { SAP_SYNC_TRIGGER } = require("../constants/sapSyncConstants");

// tenantId-jobName -> node-cron task
const tasks = new Map();
const taskKey = (tenantId, jobName) => `${tenantId}:${jobName}`;

/** Every tenant with a READY physical database — the only tenants a background job may ever touch. */
async function getReadyTenants() {
  return masterModels.TenantDatabase.findAll({ where: { status: "READY" }, raw: true });
}

/** Kept for backward compatibility with any external callers — READY tenants with an active SAP ErpConfig (also Master DB now). */
async function getSyncableTenants() {
  const ready = await getReadyTenants();
  const tenantIds = ready.map((r) => r.tenantId);
  if (tenantIds.length === 0) return [];
  const { Op } = require("sequelize");
  return masterModels.Tenant.findAll({
    where: { id: { [Op.in]: tenantIds }, status: "ACTIVE" },
    include: [{ model: masterModels.ErpConfig, where: { erpType: "SAP", status: "ACTIVE" }, required: true }],
  });
}

async function runJobFor(tenantId, jobName, triggerType, triggeredBy) {
  if (jobName === "MASTER_SYNC") return Orchestrator.runMasterSync({ tenantId, triggerType, triggeredBy });
  if (jobName === "DOCUMENT_SYNC") return Orchestrator.runDocumentSync({ tenantId, triggerType, triggeredBy });
  if (jobName === "RETRY_SYNC") return Orchestrator.runRetry({ tenantId, triggerType, triggeredBy });
  throw new Error(`Unknown job: ${jobName}`);
}

/** Orchestrator results don't carry a top-level status field — derive one from the counters, matching sapSyncLogService's own logic. */
function deriveStatus(result) {
  if (!result) return "SUCCESS";
  const failed = result.recordsFailed || 0;
  const succeeded = (result.recordsCreated || 0) + (result.recordsUpdated || 0);
  if (failed > 0 && succeeded === 0) return "FAILED";
  if (failed > 0) return "PARTIAL_SUCCESS";
  return "SUCCESS";
}

/** Executes a job immediately (Run Now button) and records the outcome on the schedule row, in that tenant's OWN database. */
async function runJobNow(tenantId, jobName, triggeredBy) {
  const { models } = await getTenantConnection(tenantId);
  const schedule = await models.SapSyncSchedule.findOne({ where: { jobName } });
  const start = Date.now();
  try {
    const result = await runJobFor(tenantId, jobName, SAP_SYNC_TRIGGER.MANUAL, triggeredBy);
    if (schedule) {
      await schedule.update({
        lastRunAt: new Date(),
        lastRunStatus: deriveStatus(result),
        lastDurationMs: Date.now() - start,
        lastSyncLogId: result?.logId || null,
      });
    }
    return result;
  } catch (error) {
    if (schedule) {
      await schedule.update({ lastRunAt: new Date(), lastRunStatus: "FAILED", lastDurationMs: Date.now() - start });
    }
    throw error;
  }
}

/** Registers (or re-registers) the node-cron task for one (tenant, job) row from its current DB state. */
async function registerTask(tenantId, scheduleRow) {
  const key = taskKey(tenantId, scheduleRow.jobName);
  const existing = tasks.get(key);
  if (existing) {
    existing.stop();
    tasks.delete(key);
  }
  if (!scheduleRow.enabled) return;
  if (!cron.validate(scheduleRow.cronExpression)) {
    console.error(`❌ [SAP Sync] Invalid cron "${scheduleRow.cronExpression}" for ${key} — task not registered`);
    return;
  }
  const task = cron.schedule(scheduleRow.cronExpression, async () => {
    const start = Date.now();
    try {
      const result = await runJobFor(tenantId, scheduleRow.jobName, SAP_SYNC_TRIGGER.SCHEDULED, null);
      const { models } = await getTenantConnection(tenantId);
      await models.SapSyncSchedule.update(
        {
          lastRunAt: new Date(),
          lastRunStatus: deriveStatus(result),
          lastDurationMs: Date.now() - start,
          lastSyncLogId: result?.logId || null,
        },
        { where: { id: scheduleRow.id } },
      );
      console.log(`✅ [SAP Sync] Scheduled ${scheduleRow.jobName} completed for tenant ${tenantId}`);
    } catch (error) {
      const { models } = await getTenantConnection(tenantId);
      await models.SapSyncSchedule.update(
        { lastRunAt: new Date(), lastRunStatus: "FAILED", lastDurationMs: Date.now() - start },
        { where: { id: scheduleRow.id } },
      );
      console.error(`❌ [SAP Sync] Scheduled ${scheduleRow.jobName} failed for tenant ${tenantId}:`, error.message);
    }
  });
  tasks.set(key, task);
}

/** Re-reads one (tenant, job) row from that tenant's OWN DB and re-registers its task. Called by the Scheduler API after an edit. */
async function reload(tenantId, jobName) {
  const { models } = await getTenantConnection(tenantId);
  const row = await models.SapSyncSchedule.findOne({ where: { jobName } });
  if (row) await registerTask(tenantId, row);
}

/**
 * Registers cron tasks for every enabled schedule row across every READY
 * tenant. Idempotent — calling start() twice stops all previous tasks
 * first. One tenant's connection/read failure is logged and skipped,
 * never falls back to a shared table.
 */
async function start() {
  stop();
  let tenantCount = 0;
  try {
    const readyTenants = await getReadyTenants();
    for (const { tenantId } of readyTenants) {
      try {
        const { models } = await getTenantConnection(tenantId);
        const rows = await models.SapSyncSchedule.findAll();
        for (const row of rows) {
          await registerTask(tenantId, row);
        }
        if (rows.length) tenantCount++;
      } catch (error) {
        console.error(`⚠️  [SAP Sync] Could not load schedules for tenant ${tenantId}:`, error.message);
      }
    }
    console.log(`🕒 SAP Sync Scheduler started — ${tasks.size} active task(s) across ${tenantCount} tenant(s)`);
  } catch (error) {
    // Master DB may not be migrated yet on a fresh environment — don't crash boot.
    console.error("⚠️  [SAP Sync] Scheduler could not load ready tenants (master migrations pending?):", error.message);
  }
}

function stop() {
  tasks.forEach((task) => task.stop());
  tasks.clear();
}

module.exports = {
  start,
  stop,
  reload,
  runJobNow,
  getSyncableTenants,
};
