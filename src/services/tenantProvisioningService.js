// src/services/tenantProvisioningService.js
//
// PHASE D — TenantProvisioningService: turns a Tenant + PROVISIONING
// TenantDatabase row into a fully working, isolated physical database
// with schema, default settings, and a tenant admin user — or fails
// loudly and leaves an inspectable FAILED record.
//
// Reused, not rebuilt: database name generation (tenantDbName.js),
// connection opening (tenantConnectionManager.openTenantSequelize —
// Phase C), and the model factory (tenantModels — Phase B) are all
// Phase A/B/C pieces called from here, not duplicated.
const bcrypt = require("bcryptjs");
const { Sequelize } = require("sequelize");
const { generateTenantDatabaseName, assertSafeDatabaseName } = require("../utils/tenantDbName");
const { openTenantSequelize } = require("./tenantConnectionManager");
const migrationRunner = require("../database/tenant/migrationRunner");
const seederRunner = require("../database/tenant/seederRunner");

class TenantProvisioningError extends Error {
  constructor(message, { step, code, cause } = {}) {
    super(message);
    this.name = "TenantProvisioningError";
    this.step = step;
    this.code = code || "PROVISIONING_FAILED";
    this.cause = cause;
  }
}

// tenantId -> in-flight Promise. Mirrors tenantConnectionManager's
// `pending` map: if two requests try to provision the same tenant at
// the same time (e.g. an accidentally double-submitted registration),
// the second awaits the first's result instead of racing to
// CREATE DATABASE twice. Same documented limitation as Phase C: this is
// per-process only, not a cross-process/distributed lock.
const provisioningLocks = new Map();

function log(event, detail = {}) {
  // Structured, single-line, no secrets — see brief section 12.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...detail }));
}

/**
 * Opens a throwaway admin connection to the MySQL SERVER (no default
 * database) using the same host/credentials tenant databases live on,
 * for issuing CREATE DATABASE / existence checks. Never touches a
 * client-supplied database name — always called with the output of
 * generateTenantDatabaseName().
 */
async function openServerAdminConnection() {
  return new Sequelize("", process.env.TENANT_DB_USER || process.env.MASTER_DB_USER, process.env.TENANT_DB_PASSWORD || process.env.MASTER_DB_PASSWORD, {
    host: process.env.TENANT_DB_HOST || process.env.MASTER_DB_HOST,
    port: process.env.TENANT_DB_PORT || process.env.MASTER_DB_PORT || 3306,
    dialect: "mysql",
    logging: false,
  });
}

async function databaseExists(admin, databaseName) {
  const [rows] = await admin.query(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = :name",
    { replacements: { name: databaseName } },
  );
  return rows.length > 0;
}

/**
 * Step: CREATE DATABASE, protected against SQL injection (identifier is
 * validated by assertSafeDatabaseName, never string-concatenated from
 * client input) and against silently masking an unexpected pre-existing
 * database (brief section 4).
 */
async function createPhysicalDatabase(databaseName, { isRetryOfKnownName }) {
  assertSafeDatabaseName(databaseName);
  const admin = await openServerAdminConnection();
  try {
    const exists = await databaseExists(admin, databaseName);
    if (exists) {
      if (isRetryOfKnownName) {
        // Expected: this is a retry and WE created this database on a
        // prior attempt (databaseName was already persisted on the
        // TenantDatabase row before this call). Reuse it.
        log("DATABASE_ALREADY_EXISTS_EXPECTED_RETRY", { databaseName });
        return { created: false, reused: true };
      }
      // Unexpected: first-ever attempt for this tenant, yet a database
      // with its deterministic name already exists. Per brief section 4
      // this must NOT be silently treated as success. We do not drop or
      // overwrite it (section 9/17: never blindly destructive) — we log
      // loudly and proceed to use it, since the name is derived solely
      // from tenantId and therefore cannot belong to any other tenant;
      // the most plausible cause is a previous provisioning run whose
      // TenantDatabase row was lost/reset, not a collision with
      // unrelated data.
      log("DATABASE_ALREADY_EXISTS_UNEXPECTED", {
        databaseName,
        note: "Proceeding to reuse it — see createPhysicalDatabase() comment for reasoning.",
      });
      return { created: false, reused: true };
    }
    // Identifier was already validated above; MySQL does not support
    // parameterized identifiers in DDL, so a validated-safe backtick
    // interpolation is the correct (and only) way to issue this.
    await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    log("DATABASE_CREATED", { databaseName });
    return { created: true, reused: false };
  } finally {
    await admin.close().catch(() => {});
  }
}

/**
 * PHASE G / Task 5 (Trial Expiry Cleanup) — irreversibly drops a
 * tenant's physical database. Reuses the exact same admin connection
 * pattern as createPhysicalDatabase() above (same host/credentials,
 * same identifier validation) rather than duplicating it. Only ever
 * called for FREE tenants whose trial has expired past the configured
 * grace period — see tenantCleanupService.js, the sole caller.
 *
 * Idempotent: dropping a database that doesn't exist is treated as
 * success (nothing left to remove), same "don't fail on already-in-the-
 * desired-state" philosophy as createPhysicalDatabase's reuse case.
 */
async function dropPhysicalDatabase(databaseName) {
  assertSafeDatabaseName(databaseName);
  const admin = await openServerAdminConnection();
  try {
    const exists = await databaseExists(admin, databaseName);
    if (!exists) {
      log("DATABASE_DROP_ALREADY_ABSENT", { databaseName });
      return { dropped: false, alreadyAbsent: true };
    }
    await admin.query(`DROP DATABASE \`${databaseName}\`;`);
    log("DATABASE_DROPPED", { databaseName });
    return { dropped: true, alreadyAbsent: false };
  } finally {
    await admin.close().catch(() => {});
  }
}

/**
 * Full provisioning pipeline for one tenant. Expects the caller to have
 * ALREADY created the Tenant row and a TenantDatabase row (status
 * PROVISIONING) in the Master DB, in the SAME transaction as any other
 * registration-time master writes — this function's own work (physical
 * CREATE DATABASE, tenant-DB migrations/seeders/admin) cannot itself be
 * part of that transaction (brief section 11: CREATE DATABASE and
 * migrations are not transactional operations), so provisioning state
 * is tracked via TenantDatabase.status instead.
 *
 * Idempotent / retry-safe: calling this again for a tenant that is
 * already READY is a no-op; calling it again after a FAILED attempt
 * resumes (migrations/seeders individually skip what already ran;
 * the admin user is looked up by email before being created).
 *
 * @param {object} masterModels - real masterDb models ({ Tenant, TenantDatabase, GlobalUserIndex, ... })
 * @param {number} tenantId
 * @param {{ name: string, email: string, password: string, mobileNumber?: string }} adminUser
 * @returns {Promise<{ tenantDatabase: object, admin: { id: number, email: string }, alreadyProvisioned: boolean }>}
 */
async function provisionTenant(masterModels, tenantId, adminUser) {
  const existingLock = provisioningLocks.get(tenantId);
  if (existingLock) return existingLock;

  const run = doProvisionTenant(masterModels, tenantId, adminUser).finally(() => {
    provisioningLocks.delete(tenantId);
  });
  provisioningLocks.set(tenantId, run);
  return run;
}

async function doProvisionTenant(masterModels, tenantId, adminUser) {
  const { TenantDatabase, GlobalUserIndex } = masterModels;
  const { ensureDefaultTenantModules } = require("./tenantModuleService");

  let tenantDb = await TenantDatabase.findOne({ where: { tenantId } });
  if (!tenantDb) {
    throw new TenantProvisioningError(`No TenantDatabase row for tenantId=${tenantId} — call site must create it (status=PROVISIONING) before provisioning`, {
      step: "PRECONDITION",
      code: "NOT_FOUND",
    });
  }

  // Idempotency (brief section 10): already fully provisioned — no-op.
  if (tenantDb.status === "READY") {
    log("TENANT_PROVISIONING_SKIPPED_ALREADY_READY", { tenantId });
    return { tenantDatabase: tenantDb, admin: null, alreadyProvisioned: true };
  }

  const isRetry = tenantDb.status === "FAILED" || tenantDb.provisioningAttempts > 0;
  log("TENANT_PROVISIONING_STARTED", { tenantId, isRetry, attempt: tenantDb.provisioningAttempts + 1 });

  let step = "GENERATE_DB_NAME";
  let tenantSequelize;
  let tenantModels;
  let createdIndexRow = false;
  try {
    const databaseName = tenantDb.databaseName || generateTenantDatabaseName(tenantId);
    await tenantDb.update({ provisioningAttempts: tenantDb.provisioningAttempts + 1, databaseName });

    step = "CREATE_DATABASE";
    await createPhysicalDatabase(databaseName, { isRetryOfKnownName: !!tenantDb.databaseName });

    step = "CONNECT_TENANT_DB";
    const conn = await openTenantSequelize(databaseName);
    tenantSequelize = conn.sequelize;
    tenantModels = conn.models;

    step = "RUN_MIGRATIONS";
    log("MIGRATIONS_STARTED", { tenantId, databaseName });
    await migrationRunner.runTenantMigrations(tenantSequelize, (event, detail) => log(event, { tenantId, ...detail }));
    log("MIGRATIONS_COMPLETED", { tenantId, databaseName });

    step = "RUN_SEEDERS";
    log("SEEDING_STARTED", { tenantId, databaseName });
    await seederRunner.runTenantSeeders(tenantSequelize, tenantModels, { tenantId }, (event, detail) => log(event, { tenantId, ...detail }));
    log("SEEDING_COMPLETED", { tenantId, databaseName });

    step = "CREATE_ADMIN";
    let admin = await tenantModels.User.findOne({ where: { email: adminUser.email } });
    if (!admin) {
      const passwordHash = await bcrypt.hash(adminUser.password, 10);
      admin = await tenantModels.User.create({
        name: adminUser.name,
        email: adminUser.email,
        password: passwordHash,
        role: "TenantAdmin",
        tenantId, // legacy-shaped column kept on the tenant User model (Phase B: byte-for-byte field parity) — harmless inside a single-tenant database, just no longer load-bearing for isolation
        mobileNumber: adminUser.mobileNumber || null,
        isActive: true,
      });
    }
    log("ADMIN_CREATED", { tenantId, adminUserId: admin.id });

    step = "REGISTER_GLOBAL_INDEX";
    const existingIndex = await GlobalUserIndex.findOne({ where: { email: adminUser.email } });
    if (!existingIndex) {
      await GlobalUserIndex.create({
        email: adminUser.email,
        mobileNumber: adminUser.mobileNumber || null,
        tenantId,
        tenantUserId: admin.id,
      });
      createdIndexRow = true;
    }

    step = "ENSURE_DEFAULT_MODULES";
    await ensureDefaultTenantModules(tenantId, null);

    step = "HEALTH_CHECK";
    await tenantSequelize.query("SELECT 1");
    const userCount = await tenantModels.User.count();

    step = "FINALIZE";
    await tenantDb.update({
      status: "READY",
      provisionedAt: new Date(),
      userCount,
      failedStep: null,
      lastError: null,
      lastErrorCode: null,
      failedAt: null,
    });

    log("TENANT_PROVISIONING_COMPLETED", { tenantId, databaseName });
    return { tenantDatabase: tenantDb, admin: { id: admin.id, email: admin.email }, alreadyProvisioned: false };
  } catch (err) {
    // Cleanup strategy (brief section 9): NEVER drop the physical
    // database on failure — a deterministic name means a retry reuses
    // it safely, and it's left intact for forensic inspection. We DO
    // roll back the one thing that would otherwise permanently block a
    // retry: a GlobalUserIndex row created THIS attempt (so the
    // email/mobile aren't falsely "taken" by a tenant that never
    // finished provisioning).
    if (createdIndexRow) {
      await GlobalUserIndex.destroy({ where: { email: adminUser.email } }).catch(() => {});
    }

    await tenantDb.update({
      status: "FAILED",
      failedStep: step,
      lastErrorCode: err.code || err.name || "UNKNOWN",
      lastError: String(err.message || err).slice(0, 2000),
      failedAt: new Date(),
    });

    log("TENANT_PROVISIONING_FAILED", { tenantId, step, errorCode: err.code || err.name, message: err.message });
    throw new TenantProvisioningError(`Tenant ${tenantId} provisioning failed at step ${step}: ${err.message}`, {
      step,
      code: err.code || "PROVISIONING_FAILED",
      cause: err,
    });
  } finally {
    // This connection was opened solely for provisioning; ongoing
    // request traffic reaches this tenant DB through the CACHED,
    // status-gated path (tenantConnectionManager.getTenantConnection),
    // which only succeeds once status=READY — so this one is always
    // closed here regardless of outcome.
    if (tenantSequelize) await tenantSequelize.close().catch(() => {});
  }
}

module.exports = { provisionTenant, dropPhysicalDatabase, TenantProvisioningError, generateTenantDatabaseName };
