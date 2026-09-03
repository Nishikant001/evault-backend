// src/services/tenantConnectionManager.js
//
// PHASE C — Tenant Connection Manager.
//
// Given a tenantId, returns a { sequelize, models } pair for that
// tenant's own physical database — creating the connection on first use,
// caching it for reuse, and cleaning it up when idle. This is what turns
// Phase B's defineTenantModels() from "a function that works" into
// "a function something actually calls."
//
// Not yet wired into the running app (that's Phase E) — this file is
// additive and self-contained, like Phase A/B before it.
const { Sequelize } = require("sequelize");
const { defineTenantModels } = require("../models/tenantModels");
const { TenantDatabase } = require("../models/masterDb");

// tenantId -> { sequelize, models, lastUsedAt }
const connections = new Map();

// tenantId -> Promise<{sequelize, models}> — in-flight connection creation.
// This is what makes getTenantConnection() concurrency-safe: if two
// requests for the same tenant arrive while the connection is still
// being created, the second caller awaits the SAME promise instead of
// racing to open a second physical connection.
const pending = new Map();

const IDLE_TIMEOUT_MS = Number(process.env.TENANT_DB_IDLE_TIMEOUT_MS || 30 * 60 * 1000); // 30 min
const SWEEP_INTERVAL_MS = Number(process.env.TENANT_DB_IDLE_SWEEP_INTERVAL_MS || 5 * 60 * 1000); // 5 min

// Connection pool sizing for EVERY tenant Sequelize instance this manager
// creates. One pool per tenant (not one pool shared across tenants) —
// each cached { sequelize, models } entry owns its own pool, sized by
// these env vars so ops can tune it without a code change. Defaults
// mirror Sequelize's own defaults (max 5, min 0, acquire 30s, idle 10s).
const TENANT_DB_POOL = {
  max: Number(process.env.TENANT_DB_POOL_MAX || 5),
  min: Number(process.env.TENANT_DB_POOL_MIN || 0),
  acquire: Number(process.env.TENANT_DB_POOL_ACQUIRE || 30000),
  idle: Number(process.env.TENANT_DB_POOL_IDLE || 10000),
};

class TenantProvisioningError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TenantProvisioningError";
    this.code = code; // "NOT_FOUND" | "NOT_READY" | "CONNECTION_FAILED"
  }
}

/**
 * Look up a tenant's physical database record in the Master DB and open
 * (or reuse) a real Sequelize connection + tenant model set for it.
 *
 * @param {number} tenantId
 * @returns {Promise<{ sequelize: Sequelize, models: ReturnType<typeof defineTenantModels> }>}
 */
async function getTenantConnection(tenantId) {
  if (!tenantId) {
    throw new TenantProvisioningError("getTenantConnection called without a tenantId", "NOT_FOUND");
  }

  const cached = connections.get(tenantId);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return { sequelize: cached.sequelize, models: cached.models };
  }

  const inFlight = pending.get(tenantId);
  if (inFlight) {
    return inFlight;
  }

  const creationPromise = createTenantConnection(tenantId)
    .then((result) => {
      pending.delete(tenantId);
      connections.set(tenantId, { ...result, lastUsedAt: Date.now() });
      return result;
    })
    .catch((err) => {
      // Do not leave a broken promise cached — the NEXT call should retry,
      // not get stuck forever with a rejected promise.
      pending.delete(tenantId);
      throw err;
    });

  pending.set(tenantId, creationPromise);
  return creationPromise;
}

async function createTenantConnection(tenantId) {
  const tenantDb = await TenantDatabase.findOne({ where: { tenantId } });

  if (!tenantDb) {
    throw new TenantProvisioningError(
      `No TenantDatabase record for tenantId=${tenantId} — tenant was never provisioned`,
      "NOT_FOUND",
    );
  }

  if (tenantDb.status !== "READY") {
    throw new TenantProvisioningError(
      `Tenant ${tenantId}'s database is not ready (status=${tenantDb.status}) — provisioning may still be in progress or failed`,
      "NOT_READY",
    );
  }

  if (!tenantDb.databaseName) {
    throw new TenantProvisioningError(
      `Tenant ${tenantId}'s TenantDatabase row has status READY but no databaseName set — data integrity issue`,
      "NOT_READY",
    );
  }

  return openTenantSequelize(tenantDb.databaseName);
}

/**
 * PHASE D — the low-level connection opener, factored out of
 * createTenantConnection() so TenantProvisioningService can use the
 * exact same connection/pool/model-binding logic WITHOUT going through
 * the READY-status gate above. Provisioning necessarily needs to talk
 * to a tenant database (to run migrations/seeders/create the admin)
 * *before* TenantDatabase.status is flipped to READY — that's the
 * whole point of the PROVISIONING state. This function does no status
 * checking at all; callers are responsible for only pointing it at a
 * database that actually exists (i.e. after CREATE DATABASE has run).
 *
 * NOT cached, NOT registered in the idle-sweep map — this always opens
 * a fresh, short-lived connection intended to be closed by its caller.
 * getTenantConnection() (the cached, status-gated path above) remains
 * the only way normal request handling reaches a tenant database.
 *
 * @param {string} databaseName
 * @returns {Promise<{ sequelize: Sequelize, models: ReturnType<typeof defineTenantModels> }>}
 */
async function openTenantSequelize(databaseName) {
  const sequelize = new Sequelize(
    databaseName,
    process.env.TENANT_DB_USER || process.env.MASTER_DB_USER,
    process.env.TENANT_DB_PASSWORD || process.env.MASTER_DB_PASSWORD,
    {
      host: process.env.TENANT_DB_HOST || process.env.MASTER_DB_HOST,
      port: process.env.TENANT_DB_PORT || process.env.MASTER_DB_PORT || 3306,
      dialect: "mysql",
      logging: false,
      pool: TENANT_DB_POOL,
    },
  );

  try {
    await sequelize.authenticate();
  } catch (err) {
    await sequelize.close().catch(() => {});
    throw new TenantProvisioningError(
      `Failed to connect to database "${databaseName}": ${err.message}`,
      "CONNECTION_FAILED",
    );
  }

  const models = defineTenantModels(sequelize);
  return { sequelize, models };
}

/** Explicitly close and evict one tenant's connection (e.g. tenant deprovisioning, or forcing a reconnect). */
async function closeTenantConnection(tenantId) {
  const cached = connections.get(tenantId);
  if (!cached) return false;
  connections.delete(tenantId);
  await cached.sequelize.close();
  return true;
}

/** Close every cached tenant connection. Call this on graceful shutdown (SIGTERM/SIGINT), wired up in Phase E's app.js changes. */
async function closeAllConnections() {
  stopIdleSweep();
  const tenantIds = Array.from(connections.keys());
  await Promise.all(tenantIds.map((id) => closeTenantConnection(id)));
}

function sweepIdleConnections() {
  const now = Date.now();
  for (const [tenantId, cached] of connections.entries()) {
    if (now - cached.lastUsedAt > IDLE_TIMEOUT_MS) {
      // Fire-and-forget close; don't let a slow close() block the sweep loop.
      closeTenantConnection(tenantId).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`tenantConnectionManager: error closing idle connection for tenant ${tenantId}:`, err.message);
      });
    }
  }
}

let sweepInterval = null;
function startIdleSweep() {
  if (sweepInterval) return;
  sweepInterval = setInterval(sweepIdleConnections, SWEEP_INTERVAL_MS);
  // Don't let this timer keep the Node process alive by itself (matters
  // for tests, scripts, and graceful shutdown).
  if (typeof sweepInterval.unref === "function") sweepInterval.unref();
}
function stopIdleSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}

// Start sweeping as soon as this module is required. Safe to do
// unconditionally: it's a no-op until at least one connection exists.
startIdleSweep();

/** For diagnostics/tests: how many tenant connections are currently cached. */
function getCacheStats() {
  return {
    active: connections.size,
    pending: pending.size,
    tenantIds: Array.from(connections.keys()),
    pool: TENANT_DB_POOL,
  };
}

module.exports = {
  getTenantConnection,
  closeTenantConnection,
  closeAllConnections,
  getCacheStats,
  startIdleSweep,
  stopIdleSweep,
  openTenantSequelize,
  TenantProvisioningError,
};
