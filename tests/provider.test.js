const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fx = require("./helpers/fixtures");
const { makeModels } = require("./helpers/fakeModels");
process.env.OCR_CREDENTIAL_ENCRYPTION_KEY = "test-only-key-0123456789-abcdefghijklmnopqrstuvwxyz";

const google = require("../src/services/ocr/providers/googleDocumentAi");
const vault = require("../src/services/ocr/credentialVault");
const settings = require("../src/services/ocr/ocrSettingsService");
const tenantModuleService = require("../src/services/tenantModuleService");
const { runOcr, OcrEngineError } = require("../src/services/ocr/engineSelector");

const SA = { type: "service_account", client_email: "ocr@my-proj-123.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nSECRETSECRET\n-----END PRIVATE KEY-----\n", token_uri: "https://oauth2.googleapis.com/token" };
const CFG = { projectId: "my-proj-123", location: "us", processorId: "abcdef1234567890" };
const entitled = (map) => test.mock.method(tenantModuleService, "assertTenantModule", async (tid) => (map[tid] ? { allowed: true } : { allowed: false, reason: "MODULE_NOT_ASSIGNED" }));
const fakeClient = (impl = {}) => ({ processorPath: (p, l, x) => `projects/${p}/locations/${l}/processors/${x}`, getProcessor: async () => [{ state: "ENABLED", type: "INVOICE_PROCESSOR" }], processDocument: async () => [{ document: { text: "Invoice No INV1", pages: [{ pageNumber: 1, dimension: { width: 100, height: 100 }, tokens: [{ layout: { confidence: 0.98, textAnchor: { textSegments: [{ startIndex: 0, endIndex: 7 }] }, boundingPoly: { normalizedVertices: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.2 }] } } }], lines: [{ layout: { textAnchor: { textSegments: [{ startIndex: 0, endIndex: 15 }] } } }] }], entities: [{ type: "invoice_id", mentionText: "INV1", confidence: 0.9 }] } }], ...impl });

// ── adapter: validation / SSRF ──
test("config validation: valid passes; hostile location/project/processor rejected", () => {
  assert.equal(google.validateConfig(CFG).ok, true);
  const bad = google.validateConfig({ projectId: "x", location: "evil.com/#@attacker", processorId: "../../x" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["location", "processorId", "projectId"]);
});
test("credentials validation: service-account only, Google token_uri only, secrets never echoed in errors", () => {
  assert.equal(google.validateCredentials(SA).ok, true);
  assert.equal(google.validateCredentials({ ...SA, token_uri: "https://evil.example/token" }).ok, false);
  assert.equal(google.validateCredentials({ ...SA, type: "authorized_user" }).ok, false);
  assert.equal(google.validateCredentials("not json").ok, false);
  const r = google.validateCredentials({ ...SA, client_email: "x@evil.com" });
  assert.ok(!JSON.stringify(r).includes("SECRETSECRET"));
});

// ── adapter: real call shapes against an injected SDK client ──
test("testConnection: connected / not enabled / each real error class is mapped", async () => {
  assert.equal((await google.testConnection({ config: CFG, credentials: SA, client: fakeClient() })).code, "CONNECTED");
  assert.equal((await google.testConnection({ config: CFG, credentials: SA, client: fakeClient({ getProcessor: async () => [{ state: "DISABLED" }] }) })).ok, false);
  const codes = { 16: "AUTH_FAILED", 7: "PERMISSION_DENIED", 5: "INVALID_PROCESSOR", 8: "QUOTA_EXCEEDED", 4: "NETWORK_TIMEOUT", 14: "NETWORK_TIMEOUT", 3: "INVALID_CONFIG" };
  for (const [grpc, expected] of Object.entries(codes)) {
    const r = await google.testConnection({ config: CFG, credentials: SA, client: fakeClient({ getProcessor: async () => { throw Object.assign(new Error("x"), { code: Number(grpc) }); } }) });
    assert.equal(r.ok, false); assert.equal(r.code, expected);
  }
});
test("provider errors are redacted (no private key / token / service-account email)", async () => {
  const leaky = "bad creds -----BEGIN PRIVATE KEY-----\nSECRETSECRET\n-----END PRIVATE KEY----- ocr@my-proj-123.iam.gserviceaccount.com Bearer ya29.abcdef";
  const r = await google.testConnection({ config: CFG, credentials: SA, client: fakeClient({ getProcessor: async () => { throw Object.assign(new Error(leaky), { code: 3, details: leaky }); } }) });
  assert.ok(!/SECRETSECRET|ya29|iam\.gserviceaccount/.test(r.message), r.message);
});
test("process: exactly ONE billable call, response converted with words/confidence/entities", async () => {
  let calls = 0;
  const client = fakeClient({ processDocument: async (...a) => { calls++; return fakeClient().processDocument(...a); } });
  const data = await google.process({ filePath: await fx.digitalPdf(), config: CFG, credentials: SA, client });
  assert.equal(calls, 1);
  assert.equal(data.provider, "GOOGLE_DOCUMENT_AI"); assert.equal(data.pages[0].words[0].confidence, 98); assert.equal(data.pages[0].words[0].text, "Invoice");
  assert.equal(data.providerEntities[0].type, "invoice_id");
});
test("process: unsupported type and oversize rejected BEFORE any provider call", async () => {
  let calls = 0; const client = fakeClient({ processDocument: async () => { calls++; return []; } });
  const txt = fx.tmp("a.txt"); fs.writeFileSync(txt, "x");
  await assert.rejects(() => google.process({ filePath: txt, config: CFG, credentials: SA, client }), (e) => e.code === "UNSUPPORTED_DOCUMENT");
  assert.equal(calls, 0);
});

// ── vault ──
test("vault: round-trip; tenant-bound (cross-tenant decrypt fails); tamper fails; no key => refuse", () => {
  const ct = vault.encrypt("topsecret", 1);
  assert.ok(!ct.includes("topsecret")); assert.equal(vault.decrypt(ct, 1), "topsecret");
  assert.throws(() => vault.decrypt(ct, 2), (e) => e.code === "OCR_CREDENTIAL_UNDECRYPTABLE");
  assert.throws(() => vault.decrypt(ct.slice(0, -4) + "AAAA", 1));
  const k = process.env.OCR_CREDENTIAL_ENCRYPTION_KEY; delete process.env.OCR_CREDENTIAL_ENCRYPTION_KEY;
  try { assert.throws(() => vault.encrypt("x", 1), (e) => e.code === "OCR_ENCRYPTION_KEY_MISSING"); } finally { process.env.OCR_CREDENTIAL_ENCRYPTION_KEY = k; }
});

// ── settings service: entitlement, masking, isolation ──
test("settings: non-entitled tenant cannot configure licensed OCR (backend-enforced)", async (t) => {
  entitled({}); t.after(() => t.mock.restoreAll());
  const models = makeModels();
  const r = await settings.saveSettings(models, 5, 1, { engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: CFG, credentials: SA, isProviderEnabled: true });
  assert.equal(r.ok, false); assert.equal(r.status, 403); assert.equal(models.OcrSettings._rows.length, 0);
  const pub = await settings.getPublicSettings(models, 5);
  assert.equal(pub.entitled, false); assert.deepEqual(pub.availableProviders, []);
  const t2 = await settings.testConnection(models, 5); assert.equal(t2.status, 403);
});
test("settings: entitled save is validated, encrypted at rest, and NEVER returned in clear", async (t) => {
  entitled({ 7: true }); t.after(() => t.mock.restoreAll());
  const models = makeModels();
  const bad = await settings.saveSettings(models, 7, 1, { engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: { ...CFG, location: "evil.com" }, credentials: SA, isProviderEnabled: true });
  assert.equal(bad.status, 400); assert.ok(bad.errors.location);
  const ok = await settings.saveSettings(models, 7, 1, { engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: CFG, credentials: SA, isProviderEnabled: true });
  assert.equal(ok.ok, true);
  const row = models.OcrSettings._rows[0];
  assert.ok(row.credentialsEncrypted && !row.credentialsEncrypted.includes("SECRETSECRET"));
  const wire = JSON.stringify(ok.settings);
  assert.ok(!/SECRETSECRET|private_key|credentialsEncrypted|iam\.gserviceaccount/.test(wire), wire);
  assert.equal(ok.settings.credentials.stored, true);
  // loading again, replacing config WITHOUT resending credentials keeps them
  const again = await settings.saveSettings(models, 7, 1, { engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: { ...CFG, location: "eu" }, isProviderEnabled: true });
  assert.equal(again.ok, true); assert.ok(models.OcrSettings._rows[0].credentialsEncrypted);
  // clearing credentials disables the provider
  const cleared = await settings.saveSettings(models, 7, 1, { clearCredentials: true, engineMode: "TESSERACT" });
  assert.equal(cleared.settings.credentials.stored, false); assert.equal(cleared.settings.isProviderEnabled, false);
});
test("settings: cannot select LICENSED without credentials / without enabling", async (t) => {
  entitled({ 7: true }); t.after(() => t.mock.restoreAll());
  const models = makeModels();
  const r = await settings.saveSettings(models, 7, 1, { engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: CFG });
  assert.equal(r.status, 400); assert.ok(r.errors.credentials);
});
test("settings: Tesseract-only save works for a non-entitled tenant", async (t) => {
  entitled({}); t.after(() => t.mock.restoreAll());
  const r = await settings.saveSettings(makeModels(), 5, 1, { engineMode: "TESSERACT", fallbackToTesseract: false });
  assert.equal(r.ok, true); assert.equal(r.settings.engineMode, "TESSERACT");
});
test("settings: Tenant A / Tenant B isolation (separate DBs; ciphertext not portable)", async (t) => {
  entitled({ 1: true, 2: true }); t.after(() => t.mock.restoreAll());
  const A = makeModels(), B = makeModels();
  await settings.saveSettings(A, 1, 10, { engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: CFG, credentials: SA, isProviderEnabled: true });
  assert.equal(await settings.loadRow(B, 2), null);
  B.OcrSettings._rows.push({ tenantId: 2, provider: "GOOGLE_DOCUMENT_AI", providerConfigJson: CFG, credentialsEncrypted: A.OcrSettings._rows[0].credentialsEncrypted, update: async () => {} });
  assert.throws(() => settings.readCredentials(B.OcrSettings._rows[0], 2), (e) => e.code === "OCR_CREDENTIAL_UNDECRYPTABLE");
});
test("settings: testConnection uses saved credentials, performs the adapter call and stores the real outcome", async (t) => {
  entitled({ 7: true }); t.after(() => t.mock.restoreAll());
  const models = makeModels();
  await settings.saveSettings(models, 7, 1, { engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: CFG, credentials: SA, isProviderEnabled: true });
  let seen;
  const adapter = { ...google, testConnection: async (a) => { seen = a; return { ok: false, code: "AUTH_FAILED", message: "Google rejected the service-account credentials." }; } };
  const r = await settings.testConnection(models, 7, { adapterOverride: adapter });
  assert.equal(r.ok, false); assert.equal(r.code, "AUTH_FAILED"); assert.equal(seen.credentials.client_email, SA.client_email);
  assert.equal(models.OcrSettings._rows[0].lastTestStatus, "AUTH_FAILED"); assert.equal(models.OcrSettings._rows[0].lastSuccessfulTestAt ?? null, null);
});

// ── engine selection / fallback ──
async function licensedRow(models, tid, extra = {}) {
  await settings.saveSettings(models, tid, 1, { engineMode: "LICENSED", provider: "GOOGLE_DOCUMENT_AI", providerConfig: CFG, credentials: SA, isProviderEnabled: true, ...extra });
}
const tessOk = (log) => async () => { log.tess++; return { extractedText: "tess text", pages: [], status: "COMPLETED" }; };
const mkDeps = (log, behaviour) => ({ tesseract: tessOk(log), getProvider: () => ({ key: "GOOGLE_DOCUMENT_AI", validateConfig: google.validateConfig, process: async () => { log.prov++; return behaviour(); } }) });

test("engine: default tenant => Tesseract, provider never touched", async (t) => {
  entitled({ 7: true }); t.after(() => t.mock.restoreAll());
  const log = { tess: 0, prov: 0 };
  const r = await runOcr({ models: makeModels(), tenantId: 7, filePath: "x", deps: mkDeps(log, async () => ({})) });
  assert.equal(r.engineUsed, "tesseract"); assert.deepEqual(log, { tess: 1, prov: 0 });
});
test("engine: licensed + enabled + entitled => provider ONCE, no Tesseract", async (t) => {
  entitled({ 7: true }); t.after(() => t.mock.restoreAll());
  const models = makeModels(); await licensedRow(models, 7); const log = { tess: 0, prov: 0 };
  const r = await runOcr({ models, tenantId: 7, filePath: "x", deps: mkDeps(log, async () => ({ extractedText: "prov text", pages: [] })) });
  assert.equal(r.engineUsed, "GOOGLE_DOCUMENT_AI"); assert.equal(r.fallbackUsed, false); assert.deepEqual(log, { tess: 0, prov: 1 });
});
test("engine: provider fails + fallback ON => Tesseract once, labelled as fallback, provider called once (no retry)", async (t) => {
  entitled({ 7: true }); t.after(() => t.mock.restoreAll());
  const models = makeModels(); await licensedRow(models, 7, { fallbackToTesseract: true }); const log = { tess: 0, prov: 0 };
  const r = await runOcr({ models, tenantId: 7, filePath: "x", deps: mkDeps(log, async () => { throw Object.assign(new Error("429 quota"), { code: "QUOTA_EXCEEDED", transient: true }); }) });
  assert.equal(r.engineUsed, "tesseract"); assert.equal(r.fallbackUsed, true); assert.equal(r.providerError.code, "QUOTA_EXCEEDED"); assert.deepEqual(log, { tess: 1, prov: 1 });
});
test("engine: provider fails + fallback OFF => real failure, recoverable, no Tesseract", async (t) => {
  entitled({ 7: true }); t.after(() => t.mock.restoreAll());
  const models = makeModels(); await licensedRow(models, 7, { fallbackToTesseract: false }); const log = { tess: 0, prov: 0 };
  await assert.rejects(() => runOcr({ models, tenantId: 7, filePath: "x", deps: mkDeps(log, async () => { throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" }); }) }),
    (e) => e instanceof OcrEngineError && e.recoverable && e.providerError.code === "PERMISSION_DENIED");
  assert.deepEqual(log, { tess: 0, prov: 1 });
});
test("engine: empty provider output is treated as failure (never overwrites with empty)", async (t) => {
  entitled({ 7: true }); t.after(() => t.mock.restoreAll());
  const models = makeModels(); await licensedRow(models, 7); const log = { tess: 0, prov: 0 };
  const r = await runOcr({ models, tenantId: 7, filePath: "x", deps: mkDeps(log, async () => ({ extractedText: "   ", pages: [] })) });
  assert.equal(r.engineUsed, "tesseract"); assert.equal(r.providerError.code, "EMPTY_RESULT");
});
test("engine: provider disabled => Tesseract; entitlement revoked => Tesseract and paid provider NOT called", async (t) => {
  entitled({ 7: true }); t.after(() => t.mock.restoreAll());
  const models = makeModels(); await licensedRow(models, 7);
  models.OcrSettings._rows[0].isProviderEnabled = false;
  let log = { tess: 0, prov: 0 };
  assert.equal((await runOcr({ models, tenantId: 7, filePath: "x", deps: mkDeps(log, async () => ({})) })).engineUsed, "tesseract"); assert.equal(log.prov, 0);
  models.OcrSettings._rows[0].isProviderEnabled = true;
  t.mock.restoreAll(); entitled({}); log = { tess: 0, prov: 0 };
  const r = await runOcr({ models, tenantId: 7, filePath: "x", deps: mkDeps(log, async () => ({})) });
  assert.equal(r.engineUsed, "tesseract"); assert.equal(log.prov, 0); assert.equal(r.providerError.code, "TENANT_MODULE_NOT_ENABLED");
});
