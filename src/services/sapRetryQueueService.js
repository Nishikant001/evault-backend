// src/services/sapRetryQueueService.js
//
// Owns the "Retry Queue" required by the brief: persists SAP records that
// failed to sync (master or document), with per-attempt history, and
// re-processes them automatically (via sapSyncScheduler's retry cron) or
// on demand (POST /api/sap-sync/retry).
//
// Kept deliberately independent of sapMasterSyncService/sapDocumentSyncService's
// internals — callers hand this service a small "retryFn" closure that knows
// how to re-attempt exactly one record, so the queue itself stays generic.

const { Op } = require("sequelize");
// PHASE G — SapSyncRetryQueue is a tenant-side model. Every exported
// function here already takes `tenantId`, so each resolves its own
// tenant connection instead of a static top-level legacy import.
const { getTenantConnection } = require("./tenantConnectionManager");
const {
  SAP_RETRY_STATUS,
  RETRY_DEFAULTS,
} = require("../constants/sapSyncConstants");

/**
 * Adds (or refreshes) a queue entry for one failing record. Idempotent on
 * (tenantId, entityType, referenceCode) — a record that fails repeatedly
 * across multiple sync runs keeps accumulating history on the SAME row
 * instead of creating duplicates.
 */
async function enqueue({ tenantId, entityType, referenceCode, payload, error, sapSyncLogId }) {
  const { SapSyncRetryQueue } = (await getTenantConnection(tenantId)).models;
  const [row, created] = await SapSyncRetryQueue.findOrCreate({
    where: { tenantId, entityType, referenceCode },
    defaults: {
      tenantId,
      entityType,
      referenceCode,
      payload,
      status: SAP_RETRY_STATUS.PENDING,
      attempts: 1,
      maxAttempts: RETRY_DEFAULTS.MAX_ATTEMPTS,
      lastError: error?.message || String(error),
      nextRetryAt: nextRetryTime(1),
      history: [{ attempt: 1, error: error?.message || String(error), timestamp: new Date() }],
      sapSyncLogId: sapSyncLogId ?? null,
    },
  });

  if (!created) {
    const attempts = row.attempts + 1;
    const history = Array.isArray(row.history) ? row.history.slice() : [];
    history.push({ attempt: attempts, error: error?.message || String(error), timestamp: new Date() });

    const abandoned = attempts >= row.maxAttempts;
    await row.update({
      payload, // keep the latest version of the record
      attempts,
      status: abandoned ? SAP_RETRY_STATUS.ABANDONED : SAP_RETRY_STATUS.PENDING,
      lastError: error?.message || String(error),
      nextRetryAt: abandoned ? null : nextRetryTime(attempts),
      history,
      sapSyncLogId: sapSyncLogId ?? row.sapSyncLogId,
    });
  }

  return row;
}

/**
 * Exponential-ish backoff: attempt N waits N * BASE_DELAY_MINUTES minutes.
 */
function nextRetryTime(attemptNumber) {
  const minutes = attemptNumber * RETRY_DEFAULTS.BASE_DELAY_MINUTES;
  return new Date(Date.now() + minutes * 60 * 1000);
}

/**
 * Marks a queue row RESOLVED after a successful retry.
 */
async function markResolved(row) {
  await row.update({
    status: SAP_RETRY_STATUS.RESOLVED,
    resolvedAt: new Date(),
    nextRetryAt: null,
  });
  return row;
}

/**
 * Fetches every row due for retry right now, optionally scoped to one
 * tenant and/or one entityType.
 */
async function getDueItems({ tenantId, entityType, limit = 200 } = {}) {
  if (!tenantId) throw new Error("sapRetryQueueService.getDueItems requires tenantId — SapSyncRetryQueue now lives per-tenant, there is no cross-tenant table to scan.");
  const { SapSyncRetryQueue } = (await getTenantConnection(tenantId)).models;
  const where = {
    status: { [Op.in]: [SAP_RETRY_STATUS.PENDING, SAP_RETRY_STATUS.RETRYING] },
    nextRetryAt: { [Op.lte]: new Date() },
  };
  if (entityType) where.entityType = entityType;

  return SapSyncRetryQueue.findAll({
    where,
    order: [["nextRetryAt", "ASC"]],
    limit,
  });
}

/**
 * Runs `retryFn(row.payload)` for every due item (optionally scoped) and
 * updates each row's status/history based on the outcome. `retryFn` must
 * return a truthy result on success and throw on failure — mirrors how
 * sapMasterSyncService / sapDocumentSyncService process a single record.
 *
 * Returns { processed, resolved, stillFailing }.
 */
async function processDueItems({ tenantId, entityType, retryFn, limit }) {
  const items = await getDueItems({ tenantId, entityType, limit });

  let resolved = 0;
  let stillFailing = 0;

  for (const item of items) {
    await item.update({ status: SAP_RETRY_STATUS.RETRYING });
    try {
      await retryFn(item.payload, item);
      await markResolved(item);
      resolved += 1;
    } catch (error) {
      await enqueue({
        tenantId: item.tenantId,
        entityType: item.entityType,
        referenceCode: item.referenceCode,
        payload: item.payload,
        error,
        sapSyncLogId: item.sapSyncLogId,
      });
      stillFailing += 1;
    }
  }

  return { processed: items.length, resolved, stillFailing };
}

async function list({ tenantId, status, entityType, page = 1, limit = 25 } = {}) {
  if (!tenantId) throw new Error("sapRetryQueueService.list requires tenantId — SapSyncRetryQueue now lives per-tenant, there is no cross-tenant table to scan.");
  const { SapSyncRetryQueue } = (await getTenantConnection(tenantId)).models;
  const where = {};
  if (status) where.status = status;
  if (entityType) where.entityType = entityType;

  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);

  const { rows, count } = await SapSyncRetryQueue.findAndCountAll({
    where,
    order: [["updatedAt", "DESC"]],
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
  });

  return {
    data: rows,
    pagination: {
      total: count,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(count / safeLimit) || 1,
    },
  };
}

module.exports = {
  enqueue,
  markResolved,
  getDueItems,
  processDueItems,
  list,
};
