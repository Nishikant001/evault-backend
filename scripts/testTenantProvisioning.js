// scripts/testTenantProvisioning.js
//
// PHASE D — end-to-end verification. Starts the REAL app (src/app.js),
// drives the REAL HTTP registration endpoints for two tenants (A and
// B), and asserts all 17 scenarios from the brief against REAL,
// physically separate MySQL/MariaDB databases — not mocks, not direct
// service calls that skip the actual controller/route layer.
//
// Usage: node scripts/testTenantProvisioning.js
// Requires: `npm run migrate:master` and `npm run seed:master:plans`
// already run once, and a MySQL/MariaDB server reachable with the
// credentials in .env (both DB_* legacy and MASTER_DB_*/TENANT_DB_*).
require("dotenv").config();

// ── Capture OTPs instead of sending real SMS (dev-mode behavior is
// already "log, don't send" — see notificationService.js — this just
// intercepts that same call so the test can read the code back). ──
const NotificationService = require("../src/services/notificationService");
const otpByMobile = new Map();
const originalSendSms = NotificationService.sendSms.bind(NotificationService);
NotificationService.sendSms = async (to, message) => {
  const match = message.match(/(\d{6})/);
  if (match) otpByMobile.set(to, match[1]);
  return originalSendSms ? { skipped: true } : undefined; // never hit the real provider in this test
};

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

const BASE = "http://127.0.0.1:4499";

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

async function registerTenant({ mobileNumber, email, ownerName, companyName, password }) {
  const otpRes = await api("POST", "/api/subscriptions/register/send-otp", { mobileNumber, email });
  if (otpRes.status !== 200) throw new Error(`send-otp failed: ${JSON.stringify(otpRes.body)}`);

  const otp = otpByMobile.get(mobileNumber);
  if (!otp) throw new Error(`No OTP captured for ${mobileNumber}`);

  const verifyRes = await api("POST", "/api/subscriptions/register/verify-otp", { mobileNumber, otp });
  if (verifyRes.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verifyRes.body)}`);

  const completeRes = await api("POST", "/api/subscriptions/register/complete", {
    mobileNumber, ownerName, companyName, password, confirmPassword: password,
  });
  return completeRes;
}

async function main() {
  process.env.PORT = "4499";
  const suffix = Date.now();

  // Boot the real app (mounts all real routes, connects legacy DB).
  require("../src/app.js");
  await new Promise((r) => setTimeout(r, 2500)); // let sync()+seed finish

  const { masterSequelize, Tenant: MasterTenant, TenantDatabase, GlobalUserIndex } = require("../src/models/masterDb");
  const { Sequelize } = require("sequelize");
  const admin = new Sequelize("", process.env.TENANT_DB_USER, process.env.TENANT_DB_PASSWORD, {
    host: process.env.TENANT_DB_HOST, port: process.env.TENANT_DB_PORT, dialect: "mysql", logging: false,
  });

  // ── SuperAdmin login (for the provisioning API tests later) ──
  const loginRes = await api("POST", "/api/auth/login", {
    email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD,
  });
  const superAdminToken = loginRes.body && (loginRes.body.accessToken || loginRes.body.token);
  record("(setup) SuperAdmin login for provisioning-API tests", loginRes.status === 200 && !!superAdminToken, `status=${loginRes.status}`);

  // ── 1-2. Tenant A registration succeeds; physical database A created ──
  const mobileA = `9${String(suffix).slice(-9)}`;
  const regA = await registerTenant({
    mobileNumber: mobileA, email: `tenant-a-${suffix}@example.com`,
    ownerName: "Owner A", companyName: `Test Company A ${suffix}`, password: "PasswordA123!",
  });
  record("1. Tenant A registration succeeds", regA.status === 201, `status=${regA.status} body=${JSON.stringify(regA.body).slice(0, 200)}`);
  const tenantAId = regA.body && regA.body.tenant && regA.body.tenant.id;
  const tokenA = regA.body && regA.body.accessToken;

  const tdA = tenantAId && (await TenantDatabase.findOne({ where: { tenantId: tenantAId } }));
  record("2. Physical database A is created", !!tdA && tdA.status === "READY", `db=${tdA && tdA.databaseName} status=${tdA && tdA.status}`);

  // ── 3-4. Tenant B registration succeeds; physical database B created ──
  const mobileB = `8${String(suffix).slice(-9)}`;
  const regB = await registerTenant({
    mobileNumber: mobileB, email: `tenant-b-${suffix}@example.com`,
    ownerName: "Owner B", companyName: `Test Company B ${suffix}`, password: "PasswordB123!",
  });
  record("3. Tenant B registration succeeds", regB.status === 201, `status=${regB.status} body=${JSON.stringify(regB.body).slice(0, 200)}`);
  const tenantBId = regB.body && regB.body.tenant && regB.body.tenant.id;
  const tokenB = regB.body && regB.body.accessToken;

  const tdB = tenantBId && (await TenantDatabase.findOne({ where: { tenantId: tenantBId } }));
  record("4. Physical database B is created", !!tdB && tdB.status === "READY", `db=${tdB && tdB.databaseName} status=${tdB && tdB.status}`);

  // ── 5. Database names are different ──
  record("5. Database names are different", tdA && tdB && tdA.databaseName !== tdB.databaseName, `A=${tdA && tdA.databaseName} B=${tdB && tdB.databaseName}`);

  // ── 6-7. Tenant A/B migrations exist only in their own DB ──
  const [migTablesA] = tdA ? await admin.query(`SELECT COUNT(*) as c FROM information_schema.tables WHERE table_schema = '${tdA.databaseName}' AND table_name = 'tenant_schema_migrations'`) : [[{ c: 0 }]];
  const [migTablesB] = tdB ? await admin.query(`SELECT COUNT(*) as c FROM information_schema.tables WHERE table_schema = '${tdB.databaseName}' AND table_name = 'tenant_schema_migrations'`) : [[{ c: 0 }]];
  record("6. Tenant A migrations table exists only in A DB", migTablesA[0].c === 1);
  record("7. Tenant B migrations table exists only in B DB", migTablesB[0].c === 1);

  // ── 8-9. Tenant A/B admin exists only in their own DB ──
  const [usersA] = tdA ? await admin.query(`SELECT email FROM \`${tdA.databaseName}\`.users`) : [[]];
  const [usersB] = tdB ? await admin.query(`SELECT email FROM \`${tdB.databaseName}\`.users`) : [[]];
  const aHasOwnAdmin = usersA.some((u) => u.email === `tenant-a-${suffix}@example.com`) && !usersA.some((u) => u.email === `tenant-b-${suffix}@example.com`);
  const bHasOwnAdmin = usersB.some((u) => u.email === `tenant-b-${suffix}@example.com`) && !usersB.some((u) => u.email === `tenant-a-${suffix}@example.com`);
  record("8. Tenant A admin exists only in A DB", aHasOwnAdmin, `A DB users: ${usersA.map((u) => u.email).join(",")}`);
  record("9. Tenant B admin exists only in B DB", bHasOwnAdmin, `B DB users: ${usersB.map((u) => u.email).join(",")}`);

  // ── 10-11. Status = READY for both ──
  record("10. Tenant A database status = READY", tdA && tdA.status === "READY");
  record("11. Tenant B database status = READY", tdB && tdB.status === "READY");

  // ── 12-13. Tenant A/B connection works (via the real tenantConnectionManager) ──
  const { getTenantConnection, closeTenantConnection } = require("../src/services/tenantConnectionManager");
  try {
    const connA = await getTenantConnection(tenantAId);
    await connA.sequelize.query("SELECT 1");
    record("12. Tenant A connection works", true);
  } catch (e) { record("12. Tenant A connection works", false, e.message); }
  try {
    const connB = await getTenantConnection(tenantBId);
    await connB.sequelize.query("SELECT 1");
    record("13. Tenant B connection works", true);
  } catch (e) { record("13. Tenant B connection works", false, e.message); }

  // ── 14. Tenant A cannot access Tenant B ──
  // Tested at the DATA layer (physically separate databases + the
  // connection manager only ever resolving a tenantId to its OWN
  // database), not through an HTTP request using Tenant A's issued
  // token against a Tenant-B-scoped endpoint. Reason, stated plainly:
  // authMiddleware.js still resolves req.user by querying the LEGACY
  // shared `User` table for every request (see its own file-level
  // comment) — it does not yet know how to look a user up inside their
  // OWN tenant database. Wiring request-time auth through per-tenant
  // databases is the "Tenant Resolver" work explicitly reserved for
  // Phase E (see PHASE_C_REPORT.md and this phase's own brief, section
  // "Do NOT implement the complete Tenant Resolver yet"). Asserting
  // isolation via HTTP right now would either false-fail on an
  // unrelated, not-yet-built layer, or worse, silently pass for the
  // wrong reason. What Phase D actually guarantees — and what's tested
  // here — is that Tenant A's connection can only ever reach Tenant A's
  // physical database, and querying it directly returns zero rows of
  // Tenant B's data.
  const connAForIsolation = await getTenantConnection(tenantAId);
  const connBForIsolation = await getTenantConnection(tenantBId);
  const aSeesB = await connAForIsolation.models.User.findOne({ where: { email: `tenant-b-${suffix}@example.com` } });
  const bSeesA = await connBForIsolation.models.User.findOne({ where: { email: `tenant-a-${suffix}@example.com` } });
  record(
    "14. Tenant A cannot access Tenant B (physical DB isolation)",
    connAForIsolation.sequelize !== connBForIsolation.sequelize && !aSeesB && !bSeesA,
    `distinct connections=${connAForIsolation.sequelize !== connBForIsolation.sequelize}, A sees B's admin=${!!aSeesB}, B sees A's admin=${!!bSeesA}`,
  );

  // ── 15. Failed migration produces FAILED status (Tenant C, forced failure) ──
  const mobileC = `7${String(suffix).slice(-9)}`;
  const emailC = `tenant-c-${suffix}@example.com`;

  let forceFail = true;
  const migrationRunnerModule = require("../src/database/tenant/migrationRunner");
  const originalMigrations = migrationRunnerModule.runTenantMigrations;
  migrationRunnerModule.runTenantMigrations = async (...args) => {
    if (forceFail) throw new Error("SIMULATED_MIGRATION_FAILURE (test)");
    return originalMigrations(...args);
  };

  const regC = await registerTenant({ mobileNumber: mobileC, email: emailC, ownerName: "Owner C", companyName: `Test Company C ${suffix}`, password: "PasswordC123!" });
  const tenantCId = regC.body && regC.body.tenant && regC.body.tenant.id;
  const tdCAfterFail = tenantCId && (await TenantDatabase.findOne({ where: { tenantId: tenantCId } }));
  record(
    "15. Failed migration produces FAILED status",
    regC.status === 502 && tdCAfterFail && tdCAfterFail.status === "FAILED" && tdCAfterFail.failedStep === "RUN_MIGRATIONS",
    `status=${regC.status} tdStatus=${tdCAfterFail && tdCAfterFail.status} failedStep=${tdCAfterFail && tdCAfterFail.failedStep} lastError=${tdCAfterFail && tdCAfterFail.lastError}`,
  );

  // ── 16. Retry provisioning works safely (un-force the failure, retry via SuperAdmin API) ──
  forceFail = false;
  const retryRes = await api("POST", `/api/tenants/${tenantCId}/retry-provisioning`, {
    name: "Owner C", email: emailC, password: "PasswordC123!", mobileNumber: mobileC,
  }, superAdminToken);
  const tdCAfterRetry = tenantCId && (await TenantDatabase.findOne({ where: { tenantId: tenantCId } }));
  record(
    "16. Retry provisioning works safely",
    retryRes.status === 200 && tdCAfterRetry && tdCAfterRetry.status === "READY" && tdCAfterRetry.databaseName === (tdCAfterFail && tdCAfterFail.databaseName),
    `retryStatus=${retryRes.status} finalStatus=${tdCAfterRetry && tdCAfterRetry.status} sameDbName=${tdCAfterRetry && tdCAfterRetry.databaseName === (tdCAfterFail && tdCAfterFail.databaseName)}`,
  );
  require("../src/database/tenant/migrationRunner").runTenantMigrations = originalMigrations;

  // ── 17. Duplicate provisioning does not create duplicate databases
  // (call provisionTenant twice more directly for Tenant A — already-
  // READY tenant — and confirm it's a safe no-op, not a second CREATE
  // DATABASE / second admin user). ──
  const { provisionTenant } = require("../src/services/tenantProvisioningService");
  const masterModels = require("../src/models/masterDb");
  const before = await TenantDatabase.findOne({ where: { tenantId: tenantAId } });
  const [beforeCount] = await admin.query(`SELECT COUNT(*) as c FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${before.databaseName}'`);
  const dup1 = await provisionTenant(masterModels, tenantAId, { name: "Owner A", email: `tenant-a-${suffix}@example.com`, password: "PasswordA123!", mobileNumber: mobileA });
  const dup2 = await provisionTenant(masterModels, tenantAId, { name: "Owner A", email: `tenant-a-${suffix}@example.com`, password: "PasswordA123!", mobileNumber: mobileA });
  const after = await TenantDatabase.findOne({ where: { tenantId: tenantAId } });
  const [afterCount] = await admin.query(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '${before.databaseName}%'`);
  record(
    "17. Duplicate provisioning does not create duplicate databases",
    dup1.alreadyProvisioned && dup2.alreadyProvisioned && after.databaseName === before.databaseName && afterCount.length === 1,
    `matching schemas found: ${afterCount.map((r) => r.SCHEMA_NAME).join(",")}`,
  );

  // ── 14 (physical name verification, requested separately in the report) ──
  console.log(`\nPhysical database names — A: ${tdA && tdA.databaseName} | B: ${tdB && tdB.databaseName} | C: ${tdCAfterRetry && tdCAfterRetry.databaseName}`);

  // ── cleanup ──
  await closeTenantConnection(tenantAId).catch(() => {});
  await closeTenantConnection(tenantBId).catch(() => {});
  await closeTenantConnection(tenantCId).catch(() => {});
  await admin.close().catch(() => {});
  await masterSequelize.close().catch(() => {});
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exit(1);
});
