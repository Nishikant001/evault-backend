// src/services/sapSyncLogService.js
//
// Thin helper around the SapSyncLog model so sapMasterSyncService,
// sapDocumentSyncService, and sapSyncScheduler all open/close/update their
// "Sync Logs" (start time, end time, records, duration, status, errors —
// per the brief) the exact same way.

const { getTenantConnection } = require("./tenantConnectionManager");
const { SAP_SYNC_LOG_STATUS } = require("../constants/sapSyncConstants");

/**
 * Opens a new RUNNING sync log row, in the tenant's OWN database.
 */
async function startLog({ tenantId, erpConfigId, syncType, triggerType, triggeredBy }) {
  const { models } = await getTenantConnection(tenantId);
  return models.SapSyncLog.create({
    tenantId,
    erpConfigId: erpConfigId ?? null,
    syncType,
    triggerType,
    status: SAP_SYNC_LOG_STATUS.RUNNING,
    startTime: new Date(),
    triggeredBy: triggeredBy ?? null,
  });
}

/**
 * Closes a sync log row with final counters + status.
 * `counters` may include: recordsFetched, recordsCreated, recordsUpdated,
 * recordsSkipped, recordsFailed, recordsPendingClassification, summary, errors.
 */
async function finishLog(logRow, counters = {}) {
  const endTime = new Date();
  const durationMs = endTime.getTime() - new Date(logRow.startTime).getTime();

  const recordsFailed = counters.recordsFailed || 0;
  const recordsCreated = counters.recordsCreated || 0;
  const recordsUpdated = counters.recordsUpdated || 0;

  let status = SAP_SYNC_LOG_STATUS.SUCCESS;
  if (recordsFailed > 0 && recordsCreated + recordsUpdated === 0) {
    status = SAP_SYNC_LOG_STATUS.FAILED;
  } else if (recordsFailed > 0) {
    status = SAP_SYNC_LOG_STATUS.PARTIAL_SUCCESS;
  }
  if (counters.forceStatus) {
    status = counters.forceStatus;
  }

  await logRow.update({
    endTime,
    durationMs,
    status,
    recordsFetched: counters.recordsFetched || 0,
    recordsCreated,
    recordsUpdated,
    recordsSkipped: counters.recordsSkipped || 0,
    recordsFailed,
    recordsPendingClassification: counters.recordsPendingClassification || 0,
    summary: counters.summary || null,
    errors: counters.errors || [],
  });

  return logRow;
}

/**
 * Marks a log row FAILED because the run threw before it could finish
 * (e.g. ERP config missing, SAP endpoint unreachable).
 */
async function failLog(logRow, error) {
  const endTime = new Date();
  const durationMs = endTime.getTime() - new Date(logRow.startTime).getTime();
  await logRow.update({
    endTime,
    durationMs,
    status: SAP_SYNC_LOG_STATUS.FAILED,
    errors: [
      {
        entityType: "RUN",
        message: error.message || String(error),
        timestamp: new Date(),
      },
    ],
  });
  return logRow;
}

module.exports = { startLog, finishLog, failLog };
