// scripts/testTenantResolver.js
//
// PHASE E — end-to-end verification. Boots the REAL app, registers two
// real tenants (reusing the real Phase D provisioning pipeline), logs
// in as each through the REAL (rewritten) authController.login, and
// proves — via the actual HTTP response AND a direct database check —
// that each request executed against that tenant's own physical
// database. Also covers isolation-tampering, inactive-tenant rejection,
// SuperAdmin, and connection reuse (brief section 11, all 14 scenarios).
require("dotenv").config();

const NotificationService = require("../src/services/notificationService");
const otpByMobile = new Map();
NotificationService.sendSms = async (to, message) => {
  const match = message.match(/(\d{6})/);
  if (match) otpByMobile.set(to, match[1]);
  return { skipped: true };
};

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

const BASE = "http://127.0.0.1:4500";
async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

async function registerTenant({ mobileNumber, email, ownerName, companyName, password }) {
  await api("POST", "/api/subscriptions/register/send-otp", { mobileNumber, email });
  const otp = otpByMobile.get(mobileNumber);
  await api("POST", "/api/subscriptions/register/verify-otp", { mobileNumber, otp });
  return api("POST", "/api/subscriptions/register/complete", { mobileNumber, ownerName, companyName, password, confirmPassword: password });
}

async function main() {
  process.env.PORT = "4500";
  const suffix = Date.now();
  require("../src/app.js");
  await new Promise((r) => setTimeout(r, 2500));

  const { masterSequelize, TenantDatabase } = require("../src/models/masterDb");
  const { Sequelize } = require("sequelize");
  const admin = new Sequelize("", process.env.TENANT_DB_USER, process.env.TENANT_DB_PASSWORD, {
    host: process.env.TENANT_DB_HOST, port: process.env.TENANT_DB_PORT, dialect: "mysql", logging: false,
  });

  // ── Register Tenant A and Tenant B (real Phase D pipeline) ────────
  const mobileA = `9${String(suffix).slice(-9)}`;
  const emailA = `resolver-a-${suffix}@example.com`;
  const passwordA = "PasswordA123!";
  const regA = await registerTenant({ mobileNumber: mobileA, email: emailA, ownerName: "Resolver Owner A", companyName: `Resolver Co A ${suffix}`, password: passwordA });
  const tenantAId = regA.body.tenant.id;

  const mobileB = `8${String(suffix).slice(-9)}`;
  const emailB = `resolver-b-${suffix}@example.com`;
  const passwordB = "PasswordB123!";
  const regB = await registerTenant({ mobileNumber: mobileB, email: emailB, ownerName: "Resolver Owner B", companyName: `Resolver Co B ${suffix}`, password: passwordB });
  const tenantBId = regB.body.tenant.id;

  record("(setup) Tenant A + B provisioned for resolver test", regA.status === 201 && regB.status === 201, `A=tenant${tenantAId} B=tenant${tenantBId}`);

  // ── 1. Login Tenant A (through the REWRITTEN authController.login) ──
  const loginA = await api("POST", "/api/auth/login", { email: emailA, password: passwordA });
  record("1. Login Tenant A", loginA.status === 200 && !!loginA.body.accessToken, `status=${loginA.status}`);
  const tokenA = loginA.body && loginA.body.accessToken;

  // ── 2-3. GET /api/users executes on Tenant A's OWN physical DB ──────
  const usersA = await api("GET", "/api/users", null, tokenA);
  const tdA = await TenantDatabase.findOne({ where: { tenantId: tenantAId } });
  const [rawUsersA] = await admin.query(`SELECT email FROM \`${tdA.databaseName}\`.users`);
  const apiEmailsA = (usersA.body && usersA.body.data || []).map((u) => u.email);
  record(
    "2-3. GET /api/users for Tenant A executes on tenant_" + tenantAId + " (not the shared DB)",
    usersA.status === 200 && apiEmailsA.includes(emailA) && rawUsersA.map((r) => r.email).sort().join(",") === apiEmailsA.slice().sort().join(","),
    `API returned: ${apiEmailsA.join(",")} | DB tenant_${tenantAId}.users: ${rawUsersA.map((r) => r.email).join(",")}`,
  );

  // ── 4-5. Login Tenant B, verify it hits Tenant B's own physical DB ──
  const loginB = await api("POST", "/api/auth/login", { email: emailB, password: passwordB });
  const tokenB = loginB.body && loginB.body.accessToken;
  const usersB = await api("GET", "/api/users", null, tokenB);
  const tdB = await TenantDatabase.findOne({ where: { tenantId: tenantBId } });
  const [rawUsersB] = await admin.query(`SELECT email FROM \`${tdB.databaseName}\`.users`);
  const apiEmailsB = (usersB.body && usersB.body.data || []).map((u) => u.email);
  record(
    "4-5. Login Tenant B + GET /api/users executes on tenant_" + tenantBId,
    loginB.status === 200 && usersB.status === 200 && apiEmailsB.includes(emailB) && rawUsersB.map((r) => r.email).sort().join(",") === apiEmailsB.slice().sort().join(","),
    `API returned: ${apiEmailsB.join(",")} | DB tenant_${tenantBId}.users: ${rawUsersB.map((r) => r.email).join(",")}`,
  );

  // ── 6-7. Tenant A cannot access Tenant B's data and vice versa ──────
  record("6. Tenant A cannot access Tenant B (A's user list never contains B's admin)", !apiEmailsA.includes(emailB));
  record("7. Tenant B cannot access Tenant A (B's user list never contains A's admin)", !apiEmailsB.includes(emailA));

  // ── 8. Changing tenantId in request body does not bypass isolation ──
  const createWithForeignTenantId = await api("POST", "/api/users", {
    name: "Injected", email: `injected-${suffix}@example.com`, password: "Injected123!", role: "Viewer", tenantId: tenantBId,
  }, tokenA);
  const [injectedInB] = await admin.query(`SELECT COUNT(*) as c FROM \`${tdB.databaseName}\`.users WHERE email = 'injected-${suffix}@example.com'`);
  const [injectedInA] = await admin.query(`SELECT COUNT(*) as c FROM \`${tdA.databaseName}\`.users WHERE email = 'injected-${suffix}@example.com'`);
  record(
    "8. Body tenantId=B while authenticated as A still creates the row in A's DB, not B's",
    createWithForeignTenantId.status === 201 && injectedInB[0].c === 0 && injectedInA[0].c === 1,
    `created in B's DB: ${injectedInB[0].c}, created in A's DB: ${injectedInA[0].c}`,
  );

  // ── 9. Changing tenantId in URL does not bypass isolation (SuperAdmin-
  // only route — a tenant user hitting it at all should be rejected,
  // regardless of which :id they put in the URL). ────────────────────
  const urlTamper = await api("GET", `/api/tenants/${tenantBId}`, null, tokenA);
  record("9. Tenant A token cannot use Tenant B's id in a URL to reach SuperAdmin-only tenant data", urlTamper.status === 403, `status=${urlTamper.status}`);

  // ── 10. Inactive Tenant A is rejected ────────────────────────────────
  const { Tenant: MasterTenant } = require("../src/models/masterDb");
  const tenantARow = await MasterTenant.findByPk(tenantAId);
  await tenantARow.update({ status: "INACTIVE" });
  const rejectedInactive = await api("GET", "/api/users", null, tokenA);
  record("10. Inactive Tenant A is rejected", rejectedInactive.status === 403, `status=${rejectedInactive.status} body=${JSON.stringify(rejectedInactive.body)}`);
  await tenantARow.update({ status: "ACTIVE" }); // restore for later checks

  // ── 11. Tenant with FAILED TenantDatabase is rejected ────────────────
  await tdA.update({ status: "FAILED" });
  const { closeTenantConnection } = require("../src/services/tenantConnectionManager");
  await closeTenantConnection(tenantAId); // drop the cached READY connection so the status change is actually re-checked
  const rejectedFailed = await api("GET", "/api/users", null, tokenA);
  record("11. Tenant A with FAILED TenantDatabase is rejected", rejectedFailed.status === 403, `status=${rejectedFailed.status} body=${JSON.stringify(rejectedFailed.body)}`);
  await tdA.update({ status: "READY" }); // restore

  // ── 12-13. SuperAdmin can access Master DB, does not require tenant DB ──
  const superLogin = await api("POST", "/api/auth/login", { email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD });
  const superToken = superLogin.body && superLogin.body.accessToken;
  const superList = await api("GET", "/api/tenants", null, superToken);
  record("12. SuperAdmin can access Master DB (GET /api/tenants)", superLogin.status === 200 && superList.status === 200 && Array.isArray(superList.body.data));
  record("13. SuperAdmin does not require tenant DB (request succeeded despite SuperAdmin having no tenantId)", superList.status === 200);

  // ── 14. Repeated requests reuse the same tenant connection ──────────
  const { getCacheStats } = require("../src/services/tenantConnectionManager");
  await api("GET", "/api/users", null, tokenA); // warm-up: A's connection was closed during test 11 and needs to be re-opened once
  const before = getCacheStats().active;
  await api("GET", "/api/users", null, tokenA);
  await api("GET", "/api/users", null, tokenA);
  await api("GET", "/api/users", null, tokenA);
  const after = getCacheStats().active;
  record("14. Repeated requests reuse the same tenant connection (cache size unchanged after 3 more requests)", after === before, `before=${before} after=${after}`);

  // ── cleanup ──
  await closeTenantConnection(tenantAId).catch(() => {});
  await closeTenantConnection(tenantBId).catch(() => {});
  await admin.close().catch(() => {});
  await masterSequelize.close().catch(() => {});

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exit(1);
});
