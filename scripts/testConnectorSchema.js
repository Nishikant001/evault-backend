// scripts/testConnectorSchema.js
// Offline test for the dynamic ERP connector schema (no DB, no network).
//   node scripts/testConnectorSchema.js
const assert = require("assert");
const S = require("../src/services/connector/connectorSchema");

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log("  ok  " + name); };
const enabled = (cfg, names) => { names.forEach((n) => { cfg.entities[n].enabled = true; }); return cfg; };

// 1. every protocol's starter skeleton is valid
for (const p of S.PROTOCOLS) {
  test(`starter config valid: ${p}`, () => {
    const r = S.validateConnectorConfig(p, S.defaultConnectorConfig(p));
    assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
    assert.strictEqual(r.valid, true);
  });
}

// 2. skeleton with everything enabled is also valid for every protocol
for (const p of S.PROTOCOLS) {
  test(`all entities enabled valid: ${p}`, () => {
    const cfg = enabled(S.defaultConnectorConfig(p), Object.keys(S.ENTITIES));
    const r = S.validateConnectorConfig(p, cfg);
    assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
    assert.deepStrictEqual(S.computeCapabilities(r.normalized).entities.length, 5);
  });
}

// 3. realistic REST config with transforms
test("realistic REST config normalizes", () => {
  const r = S.validateConnectorConfig("REST", {
    auth: { type: "API_KEY", in: "header", name: "X-Token" },
    entities: {
      DEPARTMENT: {
        source: { path: "/api/v1/depts", recordsPath: "data.items", pagination: { type: "PAGE", pageSize: 50 } },
        mapping: { fields: {
          code: { from: "DeptCode", transform: [{ op: "trim" }, { op: "upper" }] },
          name: { from: ["Name", "Suffix"], join: " - " },
          status: { from: "$.Active", transform: [{ op: "valueMap", map: { Y: "ACTIVE", N: "INACTIVE" } }] },
        } },
        filter: [{ path: "Type", op: "eq", value: "DOC" }],
      },
    },
  });
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
  assert.strictEqual(r.normalized.entities.DEPARTMENT.mapping.fields.code.from, "$.DeptCode");
  assert.strictEqual(r.normalized.entities.DEPARTMENT.source.recordsPath, "$.data.items");
  assert.strictEqual(r.normalized.entities.DEPARTMENT.source.pagination.sizeParam, "size");
  assert.ok(S.isSyncReady(r.normalized));
});

// 4. things that MUST be rejected
const bad = (name, protocol, cfg, needle) => test(`rejects: ${name}`, () => {
  const r = S.validateConnectorConfig(protocol, cfg);
  assert.strictEqual(r.valid, false, "expected invalid");
  assert.ok(JSON.stringify(r.errors).toLowerCase().includes(needle.toLowerCase()),
    `expected error containing "${needle}", got ${JSON.stringify(r.errors)}`);
});
const restDept = (over) => ({ entities: { DEPARTMENT: { source: { path: "/d" }, mapping: { fields: { code: { from: "a" }, name: { from: "b" } } }, ...over } } });

bad("unknown protocol", "FTPX", {}, "protocol");
bad("non-object config", "REST", "x", "json object");
bad("unknown top-level key (typo)", "REST", { authh: {} }, "unknown key");
bad("secret in config", "REST", { auth: { type: "BASIC", password: "x" } }, "secrets");
bad("absolute URL in path (SSRF)", "REST", { entities: { DEPARTMENT: { source: { path: "http://169.254.169.254/x" }, mapping: { fields: { code: { from: "a" }, name: { from: "b" } } } } } }, "relative");
bad("path traversal", "REST", { entities: { DEPARTMENT: { source: { path: "/a/../b" }, mapping: { fields: { code: { from: "a" }, name: { from: "b" } } } } } }, "..");
bad("Authorization header in source", "REST", { entities: { DEPARTMENT: { source: { path: "/d", headers: { Authorization: "x" } }, mapping: { fields: { code: { from: "a" }, name: { from: "b" } } } } } }, "auth headers");
bad("missing required mapped field", "REST", { entities: { DEPARTMENT: { source: { path: "/d" }, mapping: { fields: { code: { from: "a" } } } } } }, "not mapped");
bad("unknown canonical field", "REST", restDept({ mapping: { fields: { code: { from: "a" }, name: { from: "b" }, colour: { from: "c" } } } }), "unknown");
bad("unknown transform op", "REST", restDept({ mapping: { fields: { code: { from: "a", transform: [{ op: "eval", value: "1" }] }, name: { from: "b" } } } }), "op");
bad("both from and const", "REST", restDept({ mapping: { fields: { code: { from: "a", const: "x" }, name: { from: "b" } } } }), "not both");
bad("bad filter op", "REST", restDept({ filter: [{ path: "a", op: "regex", value: "x" }] }), "must be one of");
bad("GET with body", "REST", { entities: { DEPARTMENT: { source: { path: "/d", body: {} }, mapping: { fields: { code: { from: "a" }, name: { from: "b" } } } } } }, "cannot have a body");
bad("CURSOR pagination without nextCursorPath", "REST", { entities: { DEPARTMENT: { source: { path: "/d", pagination: { type: "CURSOR" } }, mapping: { fields: { code: { from: "a" }, name: { from: "b" } } } } } }, "nextCursorPath");
bad("OAUTH2 over http", "REST", { auth: { type: "OAUTH2_CLIENT_CREDENTIALS", oauth2: { tokenUrl: "http://x/t" } } }, "https");
bad("unknown entity", "REST", { entities: { INVOICE: { source: {} } } }, "unknown entity");

const dbCfg = (query) => ({ entities: { DEPARTMENT: { source: { driver: "postgres", connection: { host: "h", database: "d" }, query }, mapping: { fields: { code: { from: "a" }, name: { from: "b" } } } } } });
test("DATABASE accepts a plain SELECT (trailing ; ok)", () => {
  assert.strictEqual(S.validateConnectorConfig("DATABASE", dbCfg("SELECT code, name FROM dept WHERE active = 1;")).valid, true);
});
test("DATABASE accepts WITH ... SELECT", () => {
  assert.strictEqual(S.validateConnectorConfig("DATABASE", dbCfg("WITH x AS (SELECT 1 a) SELECT a FROM x")).valid, true);
});
bad("DATABASE DROP", "DATABASE", dbCfg("SELECT 1; DROP TABLE dept"), "statement");
bad("DATABASE DELETE", "DATABASE", dbCfg("DELETE FROM dept"), "select");
bad("DATABASE SELECT ... INTO", "DATABASE", dbCfg("SELECT * INTO backup FROM dept"), "read-only");
bad("DATABASE comment trick", "DATABASE", dbCfg("SELECT 1 -- x"), "comments");
bad("SOAP XXE", "SOAP", { entities: { DEPARTMENT: { source: { path: "/s", envelope: '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><a/>', recordsPath: "$.a" }, mapping: { fields: { code: { from: "a" }, name: { from: "b" } } } } } }, "doctype");
bad("FILE missing format", "FILE", { entities: { DEPARTMENT: { source: { transport: "SFTP", connection: { host: "h" }, path: "/x" }, mapping: { fields: { code: { from: "a" }, name: { from: "b" } } } } } }, "format");

// 5. erpType helpers
test("normalizeErpType", () => {
  assert.strictEqual(S.normalizeErpType("sap"), "SAP");
  assert.strictEqual(S.normalizeErpType(" Oracle Fusion "), "ORACLE_FUSION");
  assert.strictEqual(S.normalizeErpType("microsoft-dynamics"), "MICROSOFT_DYNAMICS");
  assert.strictEqual(S.normalizeErpType("1abc"), null);
  assert.strictEqual(S.normalizeErpType("A"), null);
  assert.strictEqual(S.normalizeErpType(""), null);
  assert.strictEqual(S.normalizeErpType(null), null);
});
test("defaultProtocolFor", () => {
  assert.strictEqual(S.defaultProtocolFor("SAP"), "ODATA");
  assert.strictEqual(S.defaultProtocolFor("ODOO"), "REST");
});
test("describeSchema is JSON-serialisable", () => {
  const d = JSON.parse(JSON.stringify(S.describeSchema()));
  assert.ok(d.protocols.includes("SOAP") && d.entities.DOCUMENT.fields.externalId.required);
});

console.log(`\n${passed} checks passed`);