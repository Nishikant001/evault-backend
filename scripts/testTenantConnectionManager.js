// scripts/testTenantConnectionManager.js
//
// PHASE B/C — standalone verification script.
//
// Exercises defineTenantModels() (Phase B) and getTenantConnection()
// (Phase C) against REAL physical MySQL/MariaDB databases — not mocks.
// Creates its own throwaway Master DB rows and two throwaway tenant
// databases, runs the 15 scenarios called for in the brief, prints a
// PASS/FAIL table, and cleans up after itself either way.
//
// Usage:
//   node scripts/testTenantConnectionManager.js
//
// Requires the same DB credentials already in .env (MASTER_DB_*,
// TENANT_DB_*) to be reachable, and that MySQL user to have CREATE/DROP
// DATABASE privileges (only needed for this test script's own throwaway
// tenant databases — the app itself never issues CREATE/DROP DATABASE).
require("dotenv").config();
const { Sequelize } = require("sequelize");

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  const masterSequelize = require("../src/config/masterDatabase");
  const { Tenant, TenantDatabase } = require("../src/models/masterDb");
  const {
    getTenantConnection,
    closeTenantConnection,
    closeAllConnections,
    getCacheStats,
    TenantProvisioningError,
  } = require("../src/services/tenantConnectionManager");

  const TENANT_DB_HOST = process.env.TENANT_DB_HOST || process.env.MASTER_DB_HOST;
  const TENANT_DB_PORT = process.env.TENANT_DB_PORT || process.env.MASTER_DB_PORT || 3306;
  const TENANT_DB_USER = process.env.TENANT_DB_USER || process.env.MASTER_DB_USER;
  const TENANT_DB_PASSWORD = process.env.TENANT_DB_PASSWORD || process.env.MASTER_DB_PASSWORD;

  const DB_A = "procur_tenant_test_a";
  const DB_B = "procur_tenant_test_b";
  let tenantIdA, tenantIdB, tenantIdProvisioning, tenantIdFailed, tenantIdInvalid;

  // ── 1. Master DB connection works ─────────────────────────────
  try {
    await masterSequelize.authenticate();
    record("1. Master DB connection works", true, `connected to "${masterSequelize.config.database}"`);
  } catch (err) {
    record("1. Master DB connection works", false, err.message);
    throw err; // nothing else can proceed without this
  }

  // ── setup: throwaway physical tenant databases ──────────────────
  const admin = new Sequelize("", TENANT_DB_USER, TENANT_DB_PASSWORD, {
    host: TENANT_DB_HOST,
    port: TENANT_DB_PORT,
    dialect: "mysql",
    logging: false,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB_A}\`;`);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB_B}\`;`);
  await admin.query(`CREATE DATABASE \`${DB_A}\`;`);
  await admin.query(`CREATE DATABASE \`${DB_B}\`;`);
  await admin.close();

  // ── setup: throwaway Master DB rows ──────────────────────────────
  const suffix = Date.now();
  const tA = await Tenant.create({ tenantName: "Test Tenant A", tenantCode: `TESTA-${suffix}`, status: "ACTIVE" });
  const tB = await Tenant.create({ tenantName: "Test Tenant B", tenantCode: `TESTB-${suffix}`, status: "ACTIVE" });
  const tProv = await Tenant.create({ tenantName: "Test Tenant Provisioning", tenantCode: `TESTP-${suffix}`, status: "ACTIVE" });
  const tFailed = await Tenant.create({ tenantName: "Test Tenant Failed", tenantCode: `TESTF-${suffix}`, status: "ACTIVE" });
  tenantIdA = tA.id;
  tenantIdB = tB.id;
  tenantIdProvisioning = tProv.id;
  tenantIdFailed = tFailed.id;
  tenantIdInvalid = 999999999; // no Tenant/TenantDatabase row at all

  await TenantDatabase.create({ tenantId: tenantIdA, databaseName: DB_A, status: "READY", provisionedAt: new Date() });
  await TenantDatabase.create({ tenantId: tenantIdB, databaseName: DB_B, status: "READY", provisionedAt: new Date() });
  await TenantDatabase.create({ tenantId: tenantIdProvisioning, databaseName: null, status: "PROVISIONING" });
  await TenantDatabase.create({ tenantId: tenantIdFailed, databaseName: "procur_tenant_test_failed", status: "FAILED" });

  let connA, connB;

  // ── 2 & 3. Tenant A / Tenant B connections can be created ────────
  try {
    connA = await getTenantConnection(tenantIdA);
    record("2. Tenant A connection can be created", true);
  } catch (err) {
    record("2. Tenant A connection can be created", false, err.message);
  }
  try {
    connB = await getTenantConnection(tenantIdB);
    record("3. Tenant B connection can be created", true);
  } catch (err) {
    record("3. Tenant B connection can be created", false, err.message);
  }

  // ── 4 & 5. Tenant A / B use their own respective databases ───────
  record("4. Tenant A uses database A", connA && connA.sequelize.config.database === DB_A, connA && connA.sequelize.config.database);
  record("5. Tenant B uses database B", connB && connB.sequelize.config.database === DB_B, connB && connB.sequelize.config.database);

  // ── 6. Tenant A and Tenant B Sequelize instances are different ───
  record("6. Tenant A and Tenant B Sequelize instances are different", connA && connB && connA.sequelize !== connB.sequelize);

  // ── 7 & 8. Tenant models are bound to the correct tenant Sequelize ─
  record(
    "7. Tenant A models are bound to Tenant A Sequelize",
    connA && connA.models.User.sequelize === connA.sequelize,
  );
  record(
    "8. Tenant B models are bound to Tenant B Sequelize",
    connB && connB.models.User.sequelize === connB.sequelize,
  );

  // Prove the model bindings are load-bearing, not just referential:
  // actually create+read a row through Tenant A's models against the
  // real physical database A, then confirm Tenant B's DB doesn't see it.
  try {
    await connA.sequelize.sync({ force: true }); // create tables for this throwaway DB
    const u = await connA.models.User.create({
      name: "Verify User",
      email: `verify-${suffix}@example.com`,
      password: "hashed",
      role: "Viewer",
    });
    const found = await connA.models.User.findByPk(u.id);
    record("7b. Tenant A model round-trip (create+read) against physical DB A", !!found && found.email === u.email);
  } catch (err) {
    record("7b. Tenant A model round-trip (create+read) against physical DB A", false, err.message);
  }

  // ── 9. Repeated Tenant A requests reuse the same connection ──────
  try {
    const connA2 = await getTenantConnection(tenantIdA);
    record("9. Repeated Tenant A requests reuse the same connection", connA2.sequelize === connA.sequelize);
  } catch (err) {
    record("9. Repeated Tenant A requests reuse the same connection", false, err.message);
  }

  // ── 9b. Concurrency safety: N simultaneous first-time requests → 1 connection ──
  try {
    const tenantIdConcurrent = tProv.id; // reuse a fresh id path is riskier; use a brand-new tenant instead
    const tC = await Tenant.create({ tenantName: "Test Tenant Concurrent", tenantCode: `TESTC-${suffix}`, status: "ACTIVE" });
    const DB_C = "procur_tenant_test_c";
    const admin2 = new Sequelize("", TENANT_DB_USER, TENANT_DB_PASSWORD, { host: TENANT_DB_HOST, port: TENANT_DB_PORT, dialect: "mysql", logging: false });
    await admin2.query(`DROP DATABASE IF EXISTS \`${DB_C}\`;`);
    await admin2.query(`CREATE DATABASE \`${DB_C}\`;`);
    await admin2.close();
    await TenantDatabase.create({ tenantId: tC.id, databaseName: DB_C, status: "READY", provisionedAt: new Date() });

    let authenticateCalls = 0;
    const originalAuthenticate = Sequelize.prototype.authenticate;
    Sequelize.prototype.authenticate = function (...args) {
      authenticateCalls += 1;
      return originalAuthenticate.apply(this, args);
    };
    const concurrentResults = await Promise.all(
      Array.from({ length: 10 }, () => getTenantConnection(tC.id)),
    );
    Sequelize.prototype.authenticate = originalAuthenticate;
    const allSameInstance = concurrentResults.every((r) => r.sequelize === concurrentResults[0].sequelize);
    record(
      "9b. 10 concurrent first-time requests for one tenant → single connection",
      allSameInstance && authenticateCalls === 1,
      `authenticate() called ${authenticateCalls}x`,
    );
    await closeTenantConnection(tC.id);
  } catch (err) {
    record("9b. 10 concurrent first-time requests for one tenant → single connection", false, err.message);
  }

  // ── 10. Invalid tenant is rejected ────────────────────────────────
  try {
    await getTenantConnection(tenantIdInvalid);
    record("10. Invalid tenant is rejected", false, "did not throw");
  } catch (err) {
    record("10. Invalid tenant is rejected", err instanceof TenantProvisioningError && err.code === "NOT_FOUND", err.code);
  }

  // ── 11. Inactive/not-ready tenant is rejected (PROVISIONING) ─────
  try {
    await getTenantConnection(tenantIdProvisioning);
    record("11. Inactive (PROVISIONING) tenant is rejected", false, "did not throw");
  } catch (err) {
    record("11. Inactive (PROVISIONING) tenant is rejected", err instanceof TenantProvisioningError && err.code === "NOT_READY", err.code);
  }

  // ── 12. TenantDatabase with READY status connects ────────────────
  record("12. TenantDatabase with READY status connects", !!connA && !!connB);

  // ── 13. TenantDatabase with PROVISIONING status does not connect ─
  // (same assertion as #11, restated per the brief's own numbering)
  record("13. TenantDatabase with PROVISIONING status does not connect", results.find((r) => r.name.startsWith("11.")).pass);

  // ── 14. TenantDatabase with FAILED status does not connect ───────
  try {
    await getTenantConnection(tenantIdFailed);
    record("14. TenantDatabase with FAILED status does not connect", false, "did not throw");
  } catch (err) {
    record("14. TenantDatabase with FAILED status does not connect", err instanceof TenantProvisioningError && err.code === "NOT_READY", err.code);
  }

  // ── 15. Master DB remains completely separate ────────────────────
  const masterDbName = masterSequelize.config.database;
  record(
    "15. Master DB remains completely separate from tenant DBs",
    masterDbName !== DB_A && masterDbName !== DB_B && masterSequelize !== connA.sequelize && masterSequelize !== connB.sequelize,
    `master="${masterDbName}"`,
  );

  // ── bonus: pool config actually applied ───────────────────────────
  const poolOpts = connA.sequelize.options.pool;
  record(
    "Bonus: TENANT_DB_POOL_* env vars are applied to each tenant connection",
    poolOpts && poolOpts.max === Number(process.env.TENANT_DB_POOL_MAX || 5),
    JSON.stringify(poolOpts),
  );

  // ── cleanup ────────────────────────────────────────────────────
  await closeAllConnections();
  const admin3 = new Sequelize("", TENANT_DB_USER, TENANT_DB_PASSWORD, { host: TENANT_DB_HOST, port: TENANT_DB_PORT, dialect: "mysql", logging: false });
  await admin3.query(`DROP DATABASE IF EXISTS \`${DB_A}\`;`);
  await admin3.query(`DROP DATABASE IF EXISTS \`${DB_B}\`;`);
  await admin3.query(`DROP DATABASE IF EXISTS \`procur_tenant_test_c\`;`);
  await admin3.close();
  await TenantDatabase.destroy({ where: { tenantId: [tenantIdA, tenantIdB, tenantIdProvisioning, tenantIdFailed] } });
  await Tenant.destroy({ where: { id: [tenantIdA, tenantIdB, tenantIdProvisioning, tenantIdFailed] } });
  await Tenant.destroy({ where: { tenantCode: `TESTC-${suffix}` } });
  await masterSequelize.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("FAILED:", failed.map((f) => f.name).join(", "));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exitCode = 1;
});
