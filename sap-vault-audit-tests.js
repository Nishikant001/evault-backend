"use strict";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test";

const path = require("path");
const Module = require("module");

// Is file ko apne project ke ROOT mein rakhein (jahan "src/" folder ho,
// jaise aapke "node --check src/routes/vaultRoutes.js" command mein dikha).
// __dirname automatically usi folder ka absolute path le lega, jahan yeh
// test file rakhi gayi hai — koi manual path edit karne ki zaroorat nahi.
const APP_ROOT = __dirname;

// ---- Stub out tenantConnectionManager BEFORE sapDocumentSyncService loads it ----
const tcmPath = require.resolve(path.join(APP_ROOT, "src/services/tenantConnectionManager.js"));

const fakeTenantModels = {}; // filled in per-test

const fakeTCM = {
  getTenantConnection: async (tenantId) => {
    return { sequelize: {}, models: fakeTenantModels };
  },
  TenantProvisioningError: class TenantProvisioningError extends Error {},
};

require.cache[tcmPath] = {
  id: tcmPath,
  filename: tcmPath,
  loaded: true,
  exports: fakeTCM,
};

// ---- Now load the real modules under test ----
const {
  VaultUploadError,
  uploadSapDocument,
  sanitizeFileName,
  validateExtensionAndMime,
} = require(path.join(APP_ROOT, "src/services/vaultUploadService.js"));

const {
  SapContentRetrievalError,
  getSapDocumentContent,
} = require(path.join(APP_ROOT, "src/services/sapContentRetrievalService.js"));

const { resolveSapTenantContext, SapAuthError, safeEqual } = require(
  path.join(APP_ROOT, "src/services/sapAuthService.js")
);

const { EXTENSION_MIME_MAP, MAGIC_BYTE_SIGNATURES, MAX_VAULT_FILE_SIZE_BYTES } = require(
  path.join(APP_ROOT, "src/constants/vaultUploadConstants.js")
);

// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${detail ? " :: " + detail : ""}`);
}

async function expectThrow(fn, matcher, name) {
  try {
    await fn();
    record(name, false, "did not throw");
  } catch (e) {
    const ok = matcher(e);
    record(name, ok, ok ? undefined : `unexpected error: ${e.name} ${e.message} status=${e.status}`);
  }
}

async function expectOk(fn, matcher, name) {
  try {
    const r = await fn();
    const ok = matcher(r);
    record(name, ok, ok ? undefined : `unexpected result: ${JSON.stringify(r)}`);
  } catch (e) {
    record(name, false, `threw unexpectedly: ${e.name} ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Fake in-memory tenant Document / DocumentContent models
// ---------------------------------------------------------------------------
function buildFakeModels() {
  const documents = new Map(); // id -> row
  const contents = new Map(); // documentId -> row
  let nextDocId = 1;
  let nextContentId = 1;

  class FakeTxn {
    LOCK = { UPDATE: "UPDATE" };
  }

  function makeDocInstance(row) {
    return {
      ...row,
      update: async (fields) => {
        Object.assign(row, fields);
        Object.assign(this, fields);
      },
      get id() { return row.id; },
    };
  }

  const Document = {
    sequelize: {
      transaction: async (fn) => {
        const t = new FakeTxn();
        return fn(t);
      },
    },
    findOne: async ({ where }) => {
      for (const row of documents.values()) {
        let match = true;
        for (const k of Object.keys(where)) {
          if (row[k] !== where[k]) { match = false; break; }
        }
        if (match) return wrapDoc(row);
      }
      return null;
    },
    create: async (fields) => {
      const row = { id: nextDocId++, ...fields };
      documents.set(row.id, row);
      return wrapDoc(row);
    },
  };

  function wrapDoc(row) {
    return {
      get id() { return row.id; },
      get sapDocumentId() { return row.sapDocumentId; },
      get sourceType() { return row.sourceType; },
      get tenantId() { return row.tenantId; },
      get status() { return row.status; },
      get mimeType() { return row.mimeType; },
      get originalFileName() { return row.originalFileName; },
      get tcode() { return row.tcode; },
      update: async (fields) => { Object.assign(row, fields); },
      _row: row,
    };
  }

  const DocumentContent = {
    findOne: async ({ where }) => {
      const row = contents.get(where.documentId);
      return row ? { ...row } : null;
    },
    create: async (fields) => {
      const row = { id: nextContentId++, ...fields };
      contents.set(fields.documentId, row);
      return { ...row };
    },
  };
  // patch update onto rows for storeDocumentContent
  const origFind = DocumentContent.findOne;
  DocumentContent.findOne = async (args) => {
    const row = contents.get(args.where.documentId);
    if (!row) return null;
    return {
      ...row,
      update: async (fields) => {
        Object.assign(row, fields);
        contents.set(args.where.documentId, row);
      },
    };
  };

  return { Document, DocumentContent, _raw: { documents, contents } };
}

function pdfBuffer() {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100, 0x41)]);
}
function pngBuffer() {
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(50)]);
}
function jpgBuffer() {
  return Buffer.concat([Buffer.from([0xff,0xd8,0xff]), Buffer.alloc(50)]);
}
function tiffBuffer() {
  return Buffer.concat([Buffer.from([0x49,0x49,0x2a,0x00]), Buffer.alloc(50)]);
}
function zipBuffer() {
  return Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), Buffer.alloc(50)]);
}

// Monkeypatch resolveClassification used inside vaultUploadService.
// It's imported by destructuring from sapDocumentSyncService, which uses
// our stubbed tenantConnectionManager internally. We provide fake tenant
// models with Category/DocumentType, and a fake global Department via
// masterDb — but masterDb.Department is a REAL sequelize model that will
// try to hit a real DB. To avoid that we monkeypatch resolveClassification
// directly on the module object (since vaultUploadService captured the
// function reference at require time via destructuring, we patch the
// sapDocumentSyncService module's export AND re-require is not possible —
// so instead we patch the reference used internally by shadowing).
const sapDocumentSyncService = require(path.join(APP_ROOT, "src/services/sapDocumentSyncService.js"));

async function main() {
  // ---------------- sanitizeFileName ----------------
  record("sanitizeFileName: normal name", (() => { try { return sanitizeFileName("invoice.pdf") === "invoice.pdf"; } catch { return false; } })());
  record("sanitizeFileName: rejects path traversal ../", (() => { try { sanitizeFileName("../../etc/passwd"); return false; } catch (e) { return e instanceof VaultUploadError && e.status === 400; } })());
  record("sanitizeFileName: rejects forward slash", (() => { try { sanitizeFileName("a/b.pdf"); return false; } catch (e) { return e instanceof VaultUploadError; } })());
  record("sanitizeFileName: rejects backslash", (() => { try { sanitizeFileName("a\\b.pdf"); return false; } catch (e) { return e instanceof VaultUploadError; } })());
  record("sanitizeFileName: rejects null byte", (() => { try { sanitizeFileName("a\x00.pdf"); return false; } catch (e) { return e instanceof VaultUploadError; } })());
  record("sanitizeFileName: rejects CRLF (header injection vector)", (() => { try { sanitizeFileName("a\r\nX-Injected: 1.pdf"); return false; } catch (e) { return e instanceof VaultUploadError; } })());

  // ---------------- validateExtensionAndMime ----------------
  record("validateExtensionAndMime: pdf ok", (() => { try { return validateExtensionAndMime("a.pdf", "application/pdf", pdfBuffer()) === ".pdf"; } catch { return false; } })());
  record("validateExtensionAndMime: unsupported ext rejected", (() => { try { validateExtensionAndMime("a.exe", "application/octet-stream", Buffer.alloc(10)); return false; } catch (e) { return e.status === 415; } })());
  record("validateExtensionAndMime: MIME spoof (pdf ext, exe-ish mime) rejected", (() => { try { validateExtensionAndMime("a.pdf", "application/x-msdownload", pdfBuffer()); return false; } catch (e) { return e.status === 415; } })());
  record("validateExtensionAndMime: magic byte mismatch rejected (jpg named pdf)", (() => { try { validateExtensionAndMime("a.pdf", "application/pdf", jpgBuffer()); return false; } catch (e) { return e.status === 415; } })());
  record("validateExtensionAndMime: zip via octet-stream tolerated", (() => { try { return validateExtensionAndMime("a.zip", "application/octet-stream", zipBuffer()) === ".zip"; } catch { return false; } })());

  // ---------------- sapAuthService ----------------
  await expectThrow(
    () => resolveSapTenantContext({ username: "", password: "", masterModels: { ErpConfig: {}, Tenant: {} } }),
    (e) => e instanceof SapAuthError && e.code === "MISSING_CREDENTIALS" && e.status === 401,
    "sapAuthService: missing credentials -> 401"
  );

  const fakeErpConfig = { id: 1, username: "sapuser", password: "s3cr3t", erpType: "SAP", authType: "BASIC" };
  const masterModelsBadPw = {
    ErpConfig: { findOne: async () => fakeErpConfig },
    Tenant: { findAll: async () => [{ id: 10, erpEnabled: true, status: "ACTIVE" }] },
  };
  await expectThrow(
    () => resolveSapTenantContext({ username: "sapuser", password: "WRONG", masterModels: masterModelsBadPw }),
    (e) => e instanceof SapAuthError && e.code === "BAD_CREDENTIALS" && e.status === 401,
    "sapAuthService: wrong password -> 401 generic"
  );
  await expectThrow(
    () => resolveSapTenantContext({ username: "nouser", password: "x", masterModels: { ErpConfig: { findOne: async () => null }, Tenant: {} } }),
    (e) => e instanceof SapAuthError && e.code === "BAD_CREDENTIALS" && e.status === 401,
    "sapAuthService: unknown username -> SAME generic 401 (no enumeration)"
  );
  await expectOk(
    () => resolveSapTenantContext({ username: "sapuser", password: "s3cr3t", masterModels: masterModelsBadPw }),
    (r) => r.tenant.id === 10,
    "sapAuthService: correct credentials -> resolves tenant"
  );
  await expectThrow(
    () => resolveSapTenantContext({
      username: "sapuser", password: "s3cr3t",
      masterModels: { ErpConfig: { findOne: async () => ({ ...fakeErpConfig, erpType: "ORACLE" }) }, Tenant: {} },
    }),
    (e) => e.code === "INVALID_ERP_TYPE" && e.status === 403,
    "sapAuthService: non-SAP erpType rejected"
  );
  await expectThrow(
    () => resolveSapTenantContext({
      username: "sapuser", password: "s3cr3t",
      masterModels: { ErpConfig: { findOne: async () => ({ ...fakeErpConfig, authType: "BEARER" }) }, Tenant: {} },
    }),
    (e) => e.code === "AUTH_TYPE_MISMATCH" && e.status === 403,
    "sapAuthService: non-BASIC authType rejected"
  );
  await expectThrow(
    () => resolveSapTenantContext({
      username: "sapuser", password: "s3cr3t",
      masterModels: { ErpConfig: { findOne: async () => fakeErpConfig }, Tenant: { findAll: async () => [] } },
    }),
    (e) => e.code === "NO_ACTIVE_TENANT" && e.status === 403,
    "sapAuthService: disabled ERP / inactive tenant -> NO_ACTIVE_TENANT 403"
  );
  await expectThrow(
    () => resolveSapTenantContext({
      username: "sapuser", password: "s3cr3t",
      masterModels: { ErpConfig: { findOne: async () => fakeErpConfig }, Tenant: { findAll: async () => [{ id: 1 }, { id: 2 }] } },
    }),
    (e) => e.code === "AMBIGUOUS_TENANT" && e.status === 409,
    "sapAuthService: ambiguous tenant resolution -> 409"
  );
  record("sapAuthService: safeEqual constant-time compare true", safeEqual("abc", "abc") === true);
  record("sapAuthService: safeEqual constant-time compare false", safeEqual("abc", "abd") === false);
  record("sapAuthService: safeEqual different length doesn't throw", (() => { try { return safeEqual("short", "muchlongerstring") === false; } catch { return false; } })());

  // ---------------- uploadSapDocument (via monkeypatched resolveClassification) ----------------
  const origResolveClassification = sapDocumentSyncService.resolveClassification;
  sapDocumentSyncService.resolveClassification = async (tenantId, mapped) => {
    if (mapped.departmentCode === "DEPT1" && mapped.categoryCode === "CAT1" && mapped.documentTypeCode === "DT1") {
      return { departmentId: 1, categoryId: 1, documentTypeId: 1, resolved: true };
    }
    return { departmentId: null, categoryId: null, documentTypeId: null, resolved: false };
  };
  // Need vaultUploadService to use the patched fn — but it destructured at
  // require time. Re-require via cache-clearing so it picks up our patch.
  delete require.cache[require.resolve(path.join(APP_ROOT, "src/services/vaultUploadService.js"))];
  const vaultUploadServicePatched = require(path.join(APP_ROOT, "src/services/vaultUploadService.js"));

  function baseBody(overrides = {}) {
    return {
      fileName: "invoice.pdf",
      documentType: "DT1",
      department: "DEPT1",
      category: "CAT1",
      sapDocumentId: "SAP-1001",
      tcode: "TC-0001",
      ...overrides,
    };
  }
  function baseFile(overrides = {}) {
    return { buffer: pdfBuffer(), mimetype: "application/pdf", ...overrides };
  }

  // 1. PDF upload (create)
  {
    const models = buildFakeModels();
    await expectOk(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile(), body: baseBody() }),
      (r) => r.httpStatus === 201 && r.action === "created",
      "1. PDF upload -> 201 created"
    );
  }

  // 2. JPG upload
  {
    const models = buildFakeModels();
    await expectOk(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: jpgBuffer(), mimetype: "image/jpeg" }), body: baseBody({ fileName: "photo.jpg", sapDocumentId: "SAP-JPG-1" }) }),
      (r) => r.httpStatus === 201,
      "2. JPG upload -> 201 created"
    );
  }

  // 3. PNG upload
  {
    const models = buildFakeModels();
    await expectOk(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: pngBuffer(), mimetype: "image/png" }), body: baseBody({ fileName: "scan.png", sapDocumentId: "SAP-PNG-1" }) }),
      (r) => r.httpStatus === 201,
      "3. PNG upload -> 201 created"
    );
  }

  // 4. TIFF upload
  {
    const models = buildFakeModels();
    await expectOk(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: tiffBuffer(), mimetype: "image/tiff" }), body: baseBody({ fileName: "fax.tiff", sapDocumentId: "SAP-TIF-1" }) }),
      (r) => r.httpStatus === 201,
      "4. TIFF upload -> 201 created"
    );
  }

  // 5. DOCX upload
  {
    const models = buildFakeModels();
    await expectOk(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: zipBuffer(), mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), body: baseBody({ fileName: "contract.docx", sapDocumentId: "SAP-DOCX-1" }) }),
      (r) => r.httpStatus === 201,
      "5. DOCX upload -> 201 created"
    );
  }

  // 6. XLSX upload
  {
    const models = buildFakeModels();
    await expectOk(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: zipBuffer(), mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), body: baseBody({ fileName: "sheet.xlsx", sapDocumentId: "SAP-XLSX-1" }) }),
      (r) => r.httpStatus === 201,
      "6. XLSX upload -> 201 created"
    );
  }

  // 7. ZIP upload
  {
    const models = buildFakeModels();
    await expectOk(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: zipBuffer(), mimetype: "application/zip" }), body: baseBody({ fileName: "archive.zip", sapDocumentId: "SAP-ZIP-1" }) }),
      (r) => r.httpStatus === 201,
      "7. ZIP upload -> 201 created"
    );
  }

  // 8. 50MB boundary (exactly at limit) -> allowed
  {
    const models = buildFakeModels();
    const exactBuf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(MAX_VAULT_FILE_SIZE_BYTES - 9)]);
    await expectOk(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: exactBuf }), body: baseBody({ sapDocumentId: "SAP-50MB" }) }),
      (r) => r.httpStatus === 201,
      "8. Exactly 50MB upload -> accepted"
    );
  }

  // 9. >50MB rejection
  {
    const models = buildFakeModels();
    const overBuf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(MAX_VAULT_FILE_SIZE_BYTES + 1)]);
    await expectThrow(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: overBuf }), body: baseBody({ sapDocumentId: "SAP-OVER" }) }),
      (e) => e instanceof vaultUploadServicePatched.VaultUploadError && e.status === 413,
      "9. >50MB upload -> 413 rejected"
    );
  }

  // 10. unsupported extension
  {
    const models = buildFakeModels();
    await expectThrow(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: Buffer.from("MZ...exe"), mimetype: "application/octet-stream" }), body: baseBody({ fileName: "malware.exe", sapDocumentId: "SAP-EXE-1" }) }),
      (e) => e instanceof vaultUploadServicePatched.VaultUploadError && e.status === 415,
      "10. unsupported extension (.exe) -> 415 rejected"
    );
  }

  // 11. incorrect MIME type
  {
    const models = buildFakeModels();
    await expectThrow(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: pdfBuffer(), mimetype: "image/png" }), body: baseBody({ sapDocumentId: "SAP-MIME-1" }) }),
      (e) => e instanceof vaultUploadServicePatched.VaultUploadError && e.status === 415,
      "11. incorrect MIME type (.pdf w/ image/png) -> 415 rejected"
    );
  }

  // 12. missing sapDocumentId
  {
    const models = buildFakeModels();
    await expectThrow(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile(), body: baseBody({ sapDocumentId: "" }) }),
      (e) => e instanceof vaultUploadServicePatched.VaultUploadError && e.status === 400,
      "12. missing sapDocumentId -> 400 rejected"
    );
  }

  // 13. duplicate sapDocumentId (same sourceType) -> idempotent update 200
  {
    const models = buildFakeModels();
    await vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile(), body: baseBody({ sapDocumentId: "SAP-DUP-1" }) });
    await expectOk(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: pdfBuffer() }), body: baseBody({ sapDocumentId: "SAP-DUP-1", fileName: "invoice-v2.pdf" }) }),
      (r) => r.httpStatus === 200 && r.action === "updated",
      "13. duplicate sapDocumentId (same source) -> 200 idempotent update"
    );
  }
  // 13b. duplicate sapDocumentId but owned by a DIFFERENT sourceType -> 409 conflict
  {
    const models = buildFakeModels();
    models.Document.create({ id: 999, sapDocumentId: "SAP-FOREIGN-1", sourceType: "SAP_SYNC", tenantId: 5 });
    // patch findOne to actually find via the raw map since our fake create above bypassed the id counter map correctly
    await expectThrow(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile(), body: baseBody({ sapDocumentId: "SAP-FOREIGN-1" }) }),
      (e) => e instanceof vaultUploadServicePatched.VaultUploadError && e.status === 409,
      "13b. duplicate sapDocumentId owned by SAP_SYNC -> 409 conflict (no overwrite)"
    );
  }

  // 22. checksum computed (SHA-256) on stored content
  {
    const models = buildFakeModels();
    const buf = pdfBuffer();
    await vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: buf }), body: baseBody({ sapDocumentId: "SAP-CHK-1" }) });
    const crypto = require("crypto");
    const expected = crypto.createHash("sha256").update(buf).digest("hex");
    const stored = [...models._raw.contents.values()][0];
    record("22. checksum: SHA-256 correctly computed and stored", stored.checksumSha256 === expected, stored.checksumSha256 !== expected ? `${stored.checksumSha256} != ${expected}` : undefined);
  }

  // Path traversal via fileName field (defense-in-depth, full flow)
  {
    const models = buildFakeModels();
    await expectThrow(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile(), body: baseBody({ fileName: "../../../etc/passwd", sapDocumentId: "SAP-TRAV-1" }) }),
      (e) => e instanceof vaultUploadServicePatched.VaultUploadError && e.status === 400,
      "Path traversal in fileName -> 400 rejected (full upload flow)"
    );
  }

  // Unresolved classification (bad department/category/documentType codes)
  {
    const models = buildFakeModels();
    await expectThrow(
      () => vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile(), body: baseBody({ department: "NOPE", sapDocumentId: "SAP-BADCLASS-1" }) }),
      (e) => e instanceof vaultUploadServicePatched.VaultUploadError && e.status === 422,
      "Unresolvable department/category/documentType -> 422 rejected"
    );
  }

  // ---------------- getSapDocumentContent (download / retrieval) ----------------
  // 20. document download (happy path)
  {
    const models = buildFakeModels();
    await vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile(), body: baseBody({ sapDocumentId: "SAP-DL-1" }) });
    await expectOk(
      () => getSapDocumentContent({ models, tenantId: 5, sapDocumentId: "SAP-DL-1" }),
      (r) => r.mimeType === "application/pdf" && r.fileName === "invoice.pdf" && Buffer.isBuffer(r.content),
      "20. document download -> returns correct content/mimeType/fileName"
    );
  }

  // 21. document not found
  {
    const models = buildFakeModels();
    await expectThrow(
      () => getSapDocumentContent({ models, tenantId: 5, sapDocumentId: "SAP-DOES-NOT-EXIST" }),
      (e) => e instanceof SapContentRetrievalError && e.status === 404,
      "21. document not found -> 404"
    );
  }

  // 19. cross-tenant access attempt: doc belongs to tenant 5, request as tenant 6
  {
    const models = buildFakeModels();
    await vaultUploadServicePatched.uploadSapDocument({ models, masterModels: {}, tenantId: 5, file: baseFile(), body: baseBody({ sapDocumentId: "SAP-XTEN-1" }) });
    await expectThrow(
      () => getSapDocumentContent({ models, tenantId: 6, sapDocumentId: "SAP-XTEN-1" }),
      (e) => e instanceof SapContentRetrievalError && e.status === 404,
      "19. cross-tenant access attempt -> 404 (not distinguishable from not-found)"
    );
  }

  // sourceType isolation: SAP_SYNC document must not be servable by this endpoint
  {
    const models = buildFakeModels();
    models.Document.create({ id: 500, sapDocumentId: "SAP-SYNCDOC-1", sourceType: "SAP_SYNC", tenantId: 5, status: "ACTIVE" });
    await expectThrow(
      () => getSapDocumentContent({ models, tenantId: 5, sapDocumentId: "SAP-SYNCDOC-1" }),
      (e) => e instanceof SapContentRetrievalError && e.status === 404,
      "sourceType isolation: SAP_SYNC doc not retrievable via Vault Content API -> 404"
    );
  }

  // Checksum now surfaced end-to-end: upload response + download response
  {
    const models = buildFakeModels();
    const buf = pdfBuffer();
    const crypto = require("crypto");
    const expected = crypto.createHash("sha256").update(buf).digest("hex");

    const uploadResult = await vaultUploadServicePatched.uploadSapDocument({
      models, masterModels: {}, tenantId: 5, file: baseFile({ buffer: buf }), body: baseBody({ sapDocumentId: "SAP-CHKFLOW-1" }),
    });
    record("checksum: upload response includes matching checksumSha256", uploadResult.checksumSha256 === expected);

    const dl = await getSapDocumentContent({ models, tenantId: 5, sapDocumentId: "SAP-CHKFLOW-1" });
    record("checksum: download response includes matching checksumSha256", dl.checksumSha256 === expected);
  }

  // Content-Disposition header injection defense-in-depth (simulates a
  // pre-existing/legacy row that somehow has control chars in the name)
  {
    // Re-require the controller fresh isn't necessary; import its pure helper indirectly is not exported,
    // so we validate via a small inline re-implementation check against the actual regex behavior by
    // requiring the controller module and invoking through a stubbed service.
    delete require.cache[require.resolve(path.join(APP_ROOT, "src/controllers/sapContentController.js"))];
    // sapContentController requires sapContentRetrievalService + auditService + requestContextMiddleware;
    // easiest safe check is to just re-derive the sanitization logic contract from the source text,
    // since the function isn't exported. We assert the source contains a control-char strip on filename.
    const src = require("fs").readFileSync(path.join(APP_ROOT, "src/controllers/sapContentController.js"), "utf8");
    const hasControlCharStrip = /\\x00-\\x1f/.test(src) && /replace\(\/\["\\x00-\\x1f\]\/g/.test(src);
    record("Content-Disposition: control-char/CRLF stripping present in source (defense-in-depth)", hasControlCharStrip);
  }

  sapDocumentSyncService.resolveClassification = origResolveClassification;

  // ---------------- summary ----------------
  console.log("\n================ SUMMARY ================");
  console.log(`PASS: ${pass}  FAIL: ${fail}  TOTAL: ${pass + fail}`);
  if (fail > 0) {
    console.log("\nFAILED TESTS:");
    for (const r of results) if (!r.ok) console.log(` - ${r.name}: ${r.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("FATAL TEST HARNESS ERROR:", e);
  process.exitCode = 1;
});