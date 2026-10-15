const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
process.env.OCR_CREDENTIAL_ENCRYPTION_KEY = "test-only-key-0123456789-abcdefghijklmnopqrstuvwxyz";
const { makeModels } = require("./helpers/fakeModels");

// Replace ONLY the authenticated-identity step; role + module middleware are the real ones.
const authPath = require.resolve("../src/middleware/authMiddleware");
const dbs = { 1: makeModels(), 2: makeModels() };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: (req, res, next) => {
  const who = req.headers["x-test-user"]; if (!who) return res.status(401).json({ success: false });
  const [role, tenantId] = who.split(":"); req.user = { id: 1, role, tenantId: Number(tenantId) }; req.models = dbs[tenantId] || makeModels(); next();
} };
const tenantModuleService = require("../src/services/tenantModuleService");
const express = require("express");
let server, base;
test.before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/ocr-settings", require("../src/routes/ocrSettingsRoutes"));
  await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}/api/ocr-settings`;
});
test.after(() => server.close());
const call = (method, p, who, body) => fetch(base + p, { method, headers: { "content-type": "application/json", ...(who ? { "x-test-user": who } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json() }));
const SA = { type: "service_account", client_email: "o@my-proj-123.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nTOPSECRET\n-----END PRIVATE KEY-----" };
const CFG = { projectId: "my-proj-123", location: "us", processorId: "abcdef1234567890" };

test("unauthenticated => 401; non-TenantAdmin roles => 403", async (t) => {
  t.mock.method(tenantModuleService, "assertTenantModule", async () => ({ allowed: true }));
  assert.equal((await call("GET", "/")).status, 401);
  for (const role of ["Uploader", "Manager", "Viewer", "Auditor"]) assert.equal((await call("GET", "/", `${role}:1`)).status, 403, role);
  assert.equal((await call("PUT", "/", "Uploader:1", {})).status, 403);
});
test("non-entitled tenant: GET works (entitled:false), licensed save/test/clear are 403 server-side", async (t) => {
  // stub at the master-model level so the REAL assertTenantModule + middleware run
  const { SystemModule, TenantModule } = require("../src/models/masterDb");
  t.mock.method(SystemModule, "findOne", async () => ({ id: 99, moduleKey: "licensed_ocr" }));
  t.mock.method(TenantModule, "findOne", async () => null);
  const g = await call("GET", "/", "TenantAdmin:1"); assert.equal(g.status, 200); assert.equal(g.json.data.entitled, false); assert.equal(g.json.data.freeEngine.available, true);
  assert.equal((await call("PUT", "/", "TenantAdmin:1", { engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: CFG, credentials: SA, isProviderEnabled: true })).status, 403);
  assert.equal((await call("POST", "/test", "TenantAdmin:1")).status, 403);
  assert.equal((await call("DELETE", "/credentials", "TenantAdmin:1")).status, 403);
  assert.equal((await call("PUT", "/", "TenantAdmin:1", { engineMode: "TESSERACT" })).status, 200);
});
test("entitled tenant: save OK, responses contain no secret; body tenantId is ignored; tenants isolated", async (t) => {
  t.mock.method(tenantModuleService, "assertTenantModule", async () => ({ allowed: true }));
  const put = await call("PUT", "/", "TenantAdmin:1", { tenantId: 2, engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: CFG, credentials: SA, isProviderEnabled: true });
  assert.equal(put.status, 200); assert.ok(!JSON.stringify(put.json).includes("TOPSECRET"));
  const get1 = await call("GET", "/", "TenantAdmin:1"); const get2 = await call("GET", "/", "TenantAdmin:2");
  assert.equal(get1.json.data.credentials.stored, true); assert.equal(get2.json.data.credentials.stored, false); assert.equal(get2.json.data.provider, null);
  assert.equal(dbs[1].OcrSettings._rows[0].tenantId, 1); assert.equal(dbs[2].OcrSettings._rows.length, 0);
  assert.ok(!JSON.stringify(get1.json).includes("TOPSECRET"));
});
test("invalid provider config => 400 with field errors, nothing stored", async (t) => {
  t.mock.method(tenantModuleService, "assertTenantModule", async () => ({ allowed: true }));
  const r = await call("PUT", "/", "TenantAdmin:2", { engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: { projectId: "p", location: "http://169.254.169.254/", processorId: "x" }, credentials: SA, isProviderEnabled: true });
  assert.equal(r.status, 400); assert.ok(r.json.errors.location); assert.equal(dbs[2].OcrSettings._rows.length, 0);
});
