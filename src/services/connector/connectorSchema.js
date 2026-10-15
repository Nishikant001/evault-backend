// src/services/connector/connectorSchema.js
//
// DYNAMIC ERP CONNECTOR — STEP 1: connector configuration schema.
//
// An ERP is described as DATA (erp_configs.connectorConfig, JSON), not code.
// One generic engine (Step 2/4) reads this description, so adding the 50th
// ERP means filling a form, not writing an adapter.
//
// This module is pure (no DB, no network, no dependencies). It provides:
//   - the vocabulary (protocols, auth types, canonical entities/fields,
//     transform operations)               -> constants + describeSchema()
//   - validateConnectorConfig(protocol, config) -> { valid, errors, warnings,
//     normalized }  (strict: unknown keys are errors, so typos are caught)
//   - defaultConnectorConfig(protocol)    -> starter skeleton for the UI
//   - computeCapabilities(config)         -> what the connector can do
//
// SECURITY RULES ENFORCED HERE
//   * No secrets inside connectorConfig. Passwords / API keys / client
//     secrets live in the existing ENCRYPTED erp_configs columns.
//   * No arbitrary code: field values come from paths + a WHITELIST of
//     transform operations. Nothing is eval'd.
//   * Paths must be relative (no absolute URLs)  -> no SSRF via config.
//   * Database sources must be a single read-only SELECT/WITH statement.
//   * SOAP envelopes may not declare DOCTYPE/ENTITY (XXE).

const SCHEMA_VERSION = 1;

const PROTOCOLS = ["REST", "ODATA", "SOAP", "DATABASE", "FILE", "WEBHOOK"];

const AUTH_TYPES = ["NONE", "BASIC", "BEARER", "API_KEY", "OAUTH2_CLIENT_CREDENTIALS"];

const DB_DRIVERS = ["mysql", "postgres", "mssql", "oracle"];
const FILE_TRANSPORTS = ["SFTP", "HTTP"];
const FILE_FORMATS = ["CSV", "JSON", "XML", "XLSX"];
const PAGINATION_TYPES = ["NONE", "PAGE", "OFFSET", "CURSOR", "LINK_HEADER"];
const FILTER_OPS = ["eq", "ne", "in", "notIn", "exists", "notExists", "contains", "startsWith"];

// Canonical Evault entities and the fields the sync engine understands.
// `required` = the mapping must provide it. These names match what the
// existing SAP mappers already produce (see sapSyncFieldMap.js), so the
// same downstream save/retry logic can be reused for every ERP.
const ENTITIES = {
  DEPARTMENT: {
    label: "Department",
    fields: {
      code: { required: true },
      name: { required: true },
      description: {},
      status: {},
    },
  },
  CATEGORY: {
    label: "Category",
    fields: {
      code: { required: true },
      name: { required: true },
      departmentCode: { required: true },
      description: {},
      status: {},
    },
  },
  DOCUMENT_TYPE: {
    label: "Document Type",
    fields: {
      code: { required: true },
      name: { required: true },
      categoryCode: { required: true },
      description: {},
      status: {},
    },
  },
  DOCUMENT: {
    label: "Document (metadata)",
    fields: {
      externalId: { required: true },
      fileName: {},
      description: {},
      hasOriginal: {},
      departmentCode: {},
      categoryCode: {},
      documentTypeCode: {},
      mimeType: {},
      createdOn: {},
    },
  },
  // File bytes for a DOCUMENT. Source only — there is nothing to map.
  DOCUMENT_CONTENT: {
    label: "Document content (file download)",
    sourceOnly: true,
    fields: {},
  },
};

const TRANSFORM_OPS = [
  "trim", "upper", "lower", "string", "number", "boolean", "date",
  "prefix", "suffix", "replace", "substring", "pad", "valueMap", "default",
];

// ─────────────────────────────────────────────────────────────
// small helpers
// ─────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isInt = (v) => Number.isInteger(v);

// `$.a.b[0].c` (also accepts bare `a.b` -> normalized to `$.a.b`).
const PATH_RE = /^\$?(\.?[A-Za-z0-9_\-:@#$]+|\[\d+\]|\['[^']+'\])+$|^\$$/;
function normalizePath(p) {
  if (!isStr(p) || !PATH_RE.test(p.trim())) return null;
  const t = p.trim();
  if (t === "$") return t;
  if (t.startsWith("$")) return t;
  return t.startsWith("[") ? `$${t}` : `$.${t}`;
}

const SECRET_KEY_RE = /^(password|passwd|secret|clientsecret|apikey|accesstoken|refreshtoken|privatekey|token)$/i;
const FORBIDDEN_HEADERS = ["authorization", "cookie", "x-api-key", "proxy-authorization"];

class Ctx {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  err(path, message) { this.errors.push({ path, message }); }
  warn(path, message) { this.warnings.push({ path, message }); }
}

function checkKeys(obj, allowed, path, ctx) {
  for (const key of Object.keys(obj)) {
    if (SECRET_KEY_RE.test(key)) {
      ctx.err(`${path}.${key}`, "Secrets must not be stored in connectorConfig — use the encrypted credential fields");
    } else if (!allowed.includes(key)) {
      ctx.err(`${path}.${key}`, `Unknown key "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
}

function optEnum(obj, key, allowed, path, ctx, dflt) {
  const v = obj[key];
  if (v === undefined || v === null) return dflt;
  if (!allowed.includes(v)) {
    ctx.err(`${path}.${key}`, `Must be one of: ${allowed.join(", ")}`);
    return dflt;
  }
  return v;
}

function optInt(obj, key, min, max, path, ctx, dflt) {
  const v = obj[key];
  if (v === undefined || v === null) return dflt;
  if (!isInt(v) || v < min || v > max) {
    ctx.err(`${path}.${key}`, `Must be an integer between ${min} and ${max}`);
    return dflt;
  }
  return v;
}

function optStr(obj, key, path, ctx, dflt) {
  const v = obj[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "string") {
    ctx.err(`${path}.${key}`, "Must be a string");
    return dflt;
  }
  return v;
}

function relativePath(value, path, ctx) {
  if (!isStr(value)) {
    ctx.err(path, "Required, non-empty string");
    return null;
  }
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(value.trim()) || value.trim().startsWith("//")) {
    ctx.err(path, "Must be a path relative to the ERP baseUrl, not an absolute URL");
    return null;
  }
  if (value.includes("..")) {
    ctx.err(path, "Path must not contain '..'");
    return null;
  }
  return value.trim();
}

function validateHeaders(headers, path, ctx) {
  if (headers === undefined || headers === null) return {};
  if (!isObj(headers)) { ctx.err(path, "Must be an object of header name -> string value"); return {}; }
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (FORBIDDEN_HEADERS.includes(k.toLowerCase())) {
      ctx.err(`${path}.${k}`, "Auth headers are configured in `auth`, not here");
    } else if (typeof v !== "string") {
      ctx.err(`${path}.${k}`, "Header value must be a string");
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// top-level pieces: auth / connection
// ─────────────────────────────────────────────────────────────

function validateAuth(auth, ctx) {
  const path = "auth";
  if (auth === undefined || auth === null) return { type: "NONE" };
  if (!isObj(auth)) { ctx.err(path, "Must be an object"); return { type: "NONE" }; }
  checkKeys(auth, ["type", "headerName", "in", "name", "oauth2"], path, ctx);

  const type = optEnum(auth, "type", AUTH_TYPES, path, ctx, "NONE");
  const out = { type };

  if (type === "API_KEY") {
    out.in = optEnum(auth, "in", ["header", "query"], path, ctx, "header");
    out.name = isStr(auth.name) ? auth.name.trim() : (out.in === "header" ? "x-api-key" : "api_key");
  }
  if (type === "BEARER" && auth.headerName !== undefined) {
    out.headerName = optStr(auth, "headerName", path, ctx, "Authorization");
  }
  if (type === "OAUTH2_CLIENT_CREDENTIALS") {
    const o = auth.oauth2;
    if (!isObj(o)) {
      ctx.err(`${path}.oauth2`, "Required for OAUTH2_CLIENT_CREDENTIALS");
    } else {
      checkKeys(o, ["tokenUrl", "scope", "audience", "tokenPath", "clientAuth"], `${path}.oauth2`, ctx);
      const tokenUrl = isStr(o.tokenUrl) ? o.tokenUrl.trim() : null;
      if (!tokenUrl || !/^https:\/\//i.test(tokenUrl)) ctx.err(`${path}.oauth2.tokenUrl`, "Required, must be an https:// URL");
      out.oauth2 = {
        tokenUrl,
        scope: optStr(o, "scope", `${path}.oauth2`, ctx, undefined),
        audience: optStr(o, "audience", `${path}.oauth2`, ctx, undefined),
        tokenPath: normalizePath(o.tokenPath || "$.access_token") || "$.access_token",
        clientAuth: optEnum(o, "clientAuth", ["BODY", "BASIC_HEADER"], `${path}.oauth2`, ctx, "BODY"),
      };
    }
  }
  return out;
}

function validateConnection(conn, ctx) {
  const path = "connection";
  if (conn === undefined || conn === null) {
    return { timeoutMs: 60000, verifyTls: true, headers: {}, retry: { maxAttempts: 2, backoffMs: 1000 } };
  }
  if (!isObj(conn)) { ctx.err(path, "Must be an object"); return {}; }
  checkKeys(conn, ["timeoutMs", "verifyTls", "headers", "retry", "requestsPerMinute"], path, ctx);

  let retry = { maxAttempts: 2, backoffMs: 1000 };
  if (conn.retry !== undefined && conn.retry !== null) {
    if (!isObj(conn.retry)) ctx.err(`${path}.retry`, "Must be an object");
    else {
      checkKeys(conn.retry, ["maxAttempts", "backoffMs"], `${path}.retry`, ctx);
      retry = {
        maxAttempts: optInt(conn.retry, "maxAttempts", 0, 10, `${path}.retry`, ctx, 2),
        backoffMs: optInt(conn.retry, "backoffMs", 0, 60000, `${path}.retry`, ctx, 1000),
      };
    }
  }
  const out = {
    timeoutMs: optInt(conn, "timeoutMs", 1000, 300000, path, ctx, 60000),
    verifyTls: conn.verifyTls === undefined ? true : conn.verifyTls === true,
    headers: validateHeaders(conn.headers, `${path}.headers`, ctx),
    retry,
  };
  if (conn.requestsPerMinute !== undefined && conn.requestsPerMinute !== null) {
    out.requestsPerMinute = optInt(conn, "requestsPerMinute", 1, 100000, path, ctx, undefined);
  }
  if (out.verifyTls === false) ctx.warn(`${path}.verifyTls`, "TLS verification is disabled — use only for internal/test ERPs");
  return out;
}

// ─────────────────────────────────────────────────────────────
// per-protocol `source` validators
// ─────────────────────────────────────────────────────────────

function validatePagination(p, path, ctx) {
  if (p === undefined || p === null) return { type: "NONE" };
  if (!isObj(p)) { ctx.err(path, "Must be an object"); return { type: "NONE" }; }
  checkKeys(p, ["type", "pageParam", "sizeParam", "pageSize", "startPage", "offsetParam", "cursorParam",
    "nextCursorPath", "hasMorePath", "maxPages"], path, ctx);
  const type = optEnum(p, "type", PAGINATION_TYPES, path, ctx, "NONE");
  const out = { type };
  if (type === "NONE") return out;
  out.pageSize = optInt(p, "pageSize", 1, 10000, path, ctx, 100);
  out.maxPages = optInt(p, "maxPages", 1, 10000, path, ctx, 1000);
  out.sizeParam = optStr(p, "sizeParam", path, ctx, type === "OFFSET" ? "limit" : "size");
  if (type === "PAGE") {
    out.pageParam = optStr(p, "pageParam", path, ctx, "page");
    out.startPage = optInt(p, "startPage", 0, 1000000, path, ctx, 1);
  }
  if (type === "OFFSET") out.offsetParam = optStr(p, "offsetParam", path, ctx, "offset");
  if (type === "CURSOR") {
    out.cursorParam = optStr(p, "cursorParam", path, ctx, "cursor");
    const np = normalizePath(p.nextCursorPath);
    if (!np) ctx.err(`${path}.nextCursorPath`, "Required for CURSOR pagination (e.g. $.meta.next)");
    out.nextCursorPath = np;
  }
  if (p.hasMorePath !== undefined && p.hasMorePath !== null) {
    const hp = normalizePath(p.hasMorePath);
    if (!hp) ctx.err(`${path}.hasMorePath`, "Invalid path");
    out.hasMorePath = hp;
  }
  return out;
}

function validateScalarMap(obj, path, ctx) {
  if (obj === undefined || obj === null) return {};
  if (!isObj(obj)) { ctx.err(path, "Must be an object"); return {}; }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (["string", "number", "boolean"].includes(typeof v)) out[k] = v;
    else ctx.err(`${path}.${k}`, "Value must be a string, number or boolean");
  }
  return out;
}

function validateRecordsPath(value, path, ctx, required) {
  if (value === undefined || value === null || value === "") {
    if (required) ctx.err(path, "Required — path to the array of records in the response (use $ for a root array)");
    return "$";
  }
  const np = normalizePath(value);
  if (!np) { ctx.err(path, "Invalid path (example: $.d.results)"); return "$"; }
  return np;
}

const SOURCE_VALIDATORS = {
  REST(src, path, ctx) {
    checkKeys(src, ["method", "path", "query", "headers", "body", "recordsPath", "pagination"], path, ctx);
    const method = optEnum(src, "method", ["GET", "POST"], path, ctx, "GET");
    const out = {
      method,
      path: relativePath(src.path, `${path}.path`, ctx),
      query: validateScalarMap(src.query, `${path}.query`, ctx),
      headers: validateHeaders(src.headers, `${path}.headers`, ctx),
      recordsPath: validateRecordsPath(src.recordsPath, `${path}.recordsPath`, ctx, false),
      pagination: validatePagination(src.pagination, `${path}.pagination`, ctx),
    };
    if (src.body !== undefined && src.body !== null) {
      if (method === "GET") ctx.err(`${path}.body`, "GET requests cannot have a body");
      else if (!isObj(src.body) && typeof src.body !== "string") ctx.err(`${path}.body`, "Must be an object or string");
      else out.body = src.body;
    }
    return out;
  },

  ODATA(src, path, ctx) {
    checkKeys(src, ["entitySet", "select", "filter", "expand", "orderby", "pageSize", "version", "recordsPath"], path, ctx);
    const es = isStr(src.entitySet) ? src.entitySet.trim() : null;
    if (!es || !/^[A-Za-z0-9_./()]+$/.test(es)) ctx.err(`${path}.entitySet`, "Required (e.g. DepartmentSet)");
    const listOf = (v, key) => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.some((x) => !isStr(x))) { ctx.err(`${path}.${key}`, "Must be an array of strings"); return []; }
      return v.map((x) => x.trim());
    };
    return {
      entitySet: es,
      select: listOf(src.select, "select"),
      expand: listOf(src.expand, "expand"),
      filter: optStr(src, "filter", path, ctx, undefined),
      orderby: optStr(src, "orderby", path, ctx, undefined),
      pageSize: optInt(src, "pageSize", 1, 5000, path, ctx, 500),
      version: optEnum(src, "version", ["v2", "v4"], path, ctx, undefined),
      recordsPath: src.recordsPath ? validateRecordsPath(src.recordsPath, `${path}.recordsPath`, ctx, false) : undefined,
    };
  },

  SOAP(src, path, ctx) {
    checkKeys(src, ["path", "action", "envelope", "namespaces", "recordsPath", "headers"], path, ctx);
    const envelope = isStr(src.envelope) ? src.envelope : null;
    if (!envelope) ctx.err(`${path}.envelope`, "Required — the SOAP request XML");
    else if (/<!\s*(DOCTYPE|ENTITY)/i.test(envelope)) ctx.err(`${path}.envelope`, "DOCTYPE/ENTITY declarations are not allowed");
    let namespaces = {};
    if (src.namespaces !== undefined && src.namespaces !== null) {
      if (!isObj(src.namespaces) || Object.values(src.namespaces).some((v) => typeof v !== "string")) {
        ctx.err(`${path}.namespaces`, "Must be an object of prefix -> namespace URI");
      } else namespaces = src.namespaces;
    }
    return {
      path: relativePath(src.path, `${path}.path`, ctx),
      action: optStr(src, "action", path, ctx, undefined),
      envelope,
      namespaces,
      headers: validateHeaders(src.headers, `${path}.headers`, ctx),
      recordsPath: validateRecordsPath(src.recordsPath, `${path}.recordsPath`, ctx, true),
    };
  },

  DATABASE(src, path, ctx) {
    checkKeys(src, ["driver", "connection", "query", "pageSize"], path, ctx);
    const driver = optEnum(src, "driver", DB_DRIVERS, path, ctx, undefined);
    if (!driver) ctx.err(`${path}.driver`, `Required: ${DB_DRIVERS.join(", ")}`);

    let connection = {};
    if (!isObj(src.connection)) ctx.err(`${path}.connection`, "Required — { host, port, database }");
    else {
      checkKeys(src.connection, ["host", "port", "database", "ssl"], `${path}.connection`, ctx);
      if (!isStr(src.connection.host)) ctx.err(`${path}.connection.host`, "Required");
      if (!isStr(src.connection.database)) ctx.err(`${path}.connection.database`, "Required");
      connection = {
        host: src.connection.host,
        port: optInt(src.connection, "port", 1, 65535, `${path}.connection`, ctx, undefined),
        database: src.connection.database,
        ssl: src.connection.ssl === true,
      };
    }

    const q = isStr(src.query) ? src.query.trim().replace(/;\s*$/, "") : null;
    if (!q) ctx.err(`${path}.query`, "Required — a single read-only SELECT statement");
    else {
      if (!/^(select|with)\b/i.test(q)) ctx.err(`${path}.query`, "Must start with SELECT or WITH");
      if (q.includes(";")) ctx.err(`${path}.query`, "Only one statement is allowed (no ';')");
      if (/--|\/\*/.test(q)) ctx.err(`${path}.query`, "SQL comments are not allowed");
      if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|exec|execute|merge|call|into)\b/i.test(q)) {
        ctx.err(`${path}.query`, "Only read-only queries are allowed");
      }
    }
    return { driver, connection, query: q, pageSize: optInt(src, "pageSize", 1, 10000, path, ctx, 500) };
  },

  FILE(src, path, ctx) {
    checkKeys(src, ["transport", "connection", "path", "filePattern", "format", "csv", "recordsPath", "afterRead", "moveTo"], path, ctx);
    const transport = optEnum(src, "transport", FILE_TRANSPORTS, path, ctx, undefined);
    if (!transport) ctx.err(`${path}.transport`, `Required: ${FILE_TRANSPORTS.join(", ")}`);
    const format = optEnum(src, "format", FILE_FORMATS, path, ctx, undefined);
    if (!format) ctx.err(`${path}.format`, `Required: ${FILE_FORMATS.join(", ")}`);

    let connection;
    if (transport === "SFTP") {
      if (!isObj(src.connection)) ctx.err(`${path}.connection`, "Required for SFTP — { host, port }");
      else {
        checkKeys(src.connection, ["host", "port"], `${path}.connection`, ctx);
        if (!isStr(src.connection.host)) ctx.err(`${path}.connection.host`, "Required");
        connection = { host: src.connection.host, port: optInt(src.connection, "port", 1, 65535, `${path}.connection`, ctx, 22) };
      }
    }
    const out = {
      transport, format, connection,
      path: relativePath(src.path, `${path}.path`, ctx),
      filePattern: optStr(src, "filePattern", path, ctx, "*"),
      afterRead: optEnum(src, "afterRead", ["NONE", "MOVE", "DELETE"], path, ctx, "NONE"),
    };
    if (out.afterRead === "MOVE") out.moveTo = relativePath(src.moveTo, `${path}.moveTo`, ctx);
    if (format === "CSV") {
      const c = isObj(src.csv) ? src.csv : {};
      if (src.csv !== undefined && !isObj(src.csv)) ctx.err(`${path}.csv`, "Must be an object");
      else checkKeys(c, ["delimiter", "header", "encoding"], `${path}.csv`, ctx);
      out.csv = {
        delimiter: optStr(c, "delimiter", `${path}.csv`, ctx, ","),
        header: c.header === undefined ? true : c.header === true,
        encoding: optStr(c, "encoding", `${path}.csv`, ctx, "utf8"),
      };
    }
    if (format === "JSON" || format === "XML") {
      out.recordsPath = validateRecordsPath(src.recordsPath, `${path}.recordsPath`, ctx, format === "XML");
    }
    return out;
  },

  // Inbound PUSH: the ERP calls Evault. The secret used to verify the
  // signature is the encrypted `apiKey` column, never this JSON.
  WEBHOOK(src, path, ctx) {
    checkKeys(src, ["recordsPath", "signatureType", "signatureHeader"], path, ctx);
    const signatureType = optEnum(src, "signatureType", ["NONE", "HMAC_SHA256"], path, ctx, "HMAC_SHA256");
    const out = {
      recordsPath: validateRecordsPath(src.recordsPath, `${path}.recordsPath`, ctx, false),
      signatureType,
    };
    if (signatureType !== "NONE") out.signatureHeader = optStr(src, "signatureHeader", path, ctx, "x-signature");
    else ctx.warn(path, "Webhook signature verification is disabled");
    return out;
  },
};

// ─────────────────────────────────────────────────────────────
// mapping (field -> canonical) and filters
// ─────────────────────────────────────────────────────────────

function validateTransforms(list, path, ctx) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { ctx.err(path, "Must be an array of transform steps"); return []; }
  return list.map((step, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(step) || !TRANSFORM_OPS.includes(step.op)) {
      ctx.err(p, `Each step needs "op" — one of: ${TRANSFORM_OPS.join(", ")}`);
      return null;
    }
    const need = (key, test, msg) => { if (!test(step[key])) ctx.err(`${p}.${key}`, msg); };
    switch (step.op) {
      case "prefix": case "suffix": need("value", (v) => typeof v === "string", "Required string"); break;
      case "replace": need("from", (v) => typeof v === "string" && v !== "", "Required string"); need("to", (v) => typeof v === "string", "Required string"); break;
      case "substring": need("start", isInt, "Required integer"); if (step.end !== undefined) need("end", isInt, "Must be an integer"); break;
      case "pad": need("length", (v) => isInt(v) && v > 0 && v <= 255, "Required integer 1-255"); break;
      case "valueMap": need("map", isObj, "Required object"); break;
      case "default": if (step.value === undefined) ctx.err(`${p}.value`, "Required"); break;
      default: break;
    }
    return step;
  }).filter(Boolean);
}

function validateMapping(entityName, mapping, path, ctx) {
  const def = ENTITIES[entityName];
  if (!isObj(mapping)) { ctx.err(path, "Required object"); return { fields: {} }; }
  checkKeys(mapping, ["fields"], path, ctx);
  const fields = isObj(mapping.fields) ? mapping.fields : {};
  if (!isObj(mapping.fields)) ctx.err(`${path}.fields`, "Required object of canonicalField -> field spec");

  const out = {};
  for (const [name, spec] of Object.entries(fields)) {
    const fp = `${path}.fields.${name}`;
    if (!def.fields[name]) { ctx.err(fp, `Unknown ${def.label} field (allowed: ${Object.keys(def.fields).join(", ")})`); continue; }
    if (!isObj(spec)) { ctx.err(fp, "Must be an object"); continue; }
    checkKeys(spec, ["from", "join", "const", "default", "transform"], fp, ctx);

    const norm = {};
    if (spec.from !== undefined) {
      const arr = Array.isArray(spec.from) ? spec.from : [spec.from];
      const paths = arr.map((x) => normalizePath(x));
      if (arr.length === 0 || paths.some((x) => !x)) ctx.err(`${fp}.from`, "Must be a valid path (e.g. $.Dept.Code) or an array of paths");
      else norm.from = Array.isArray(spec.from) ? paths : paths[0];
      if (Array.isArray(spec.from) && spec.from.length > 1) norm.join = optStr(spec, "join", fp, ctx, " ");
    }
    if (spec.const !== undefined) norm.const = spec.const;
    if (spec.from === undefined && spec.const === undefined) ctx.err(fp, 'Needs either "from" or "const"');
    if (spec.from !== undefined && spec.const !== undefined) ctx.err(fp, 'Use either "from" or "const", not both');
    if (spec.default !== undefined) norm.default = spec.default;
    norm.transform = validateTransforms(spec.transform, `${fp}.transform`, ctx);
    out[name] = norm;
  }

  for (const [name, meta] of Object.entries(def.fields)) {
    if (meta.required && !out[name]) ctx.err(`${path}.fields.${name}`, `Required ${def.label} field is not mapped`);
  }
  return { fields: out };
}

function validateFilters(list, path, ctx) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { ctx.err(path, "Must be an array"); return []; }
  return list.map((f, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(f)) { ctx.err(p, "Must be an object"); return null; }
    checkKeys(f, ["path", "op", "value"], p, ctx);
    const np = normalizePath(f.path);
    if (!np) ctx.err(`${p}.path`, "Invalid path");
    const op = FILTER_OPS.includes(f.op) ? f.op : (ctx.err(`${p}.op`, `Must be one of: ${FILTER_OPS.join(", ")}`), null);
    if (["in", "notIn"].includes(op) && !Array.isArray(f.value)) ctx.err(`${p}.value`, "Must be an array");
    if (["eq", "ne", "contains", "startsWith"].includes(op) && f.value === undefined) ctx.err(`${p}.value`, "Required");
    return { path: np, op, value: f.value };
  }).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// public API
// ─────────────────────────────────────────────────────────────

/**
 * Validates + normalizes a connectorConfig for the given protocol.
 * Never throws. `normalized` is only trustworthy when `valid` is true.
 */
function validateConnectorConfig(protocol, config) {
  const ctx = new Ctx();

  if (!PROTOCOLS.includes(protocol)) {
    ctx.err("protocol", `Must be one of: ${PROTOCOLS.join(", ")}`);
    return { valid: false, errors: ctx.errors, warnings: ctx.warnings, normalized: null };
  }
  if (!isObj(config)) {
    ctx.err("", "connectorConfig must be a JSON object");
    return { valid: false, errors: ctx.errors, warnings: ctx.warnings, normalized: null };
  }
  checkKeys(config, ["schemaVersion", "auth", "connection", "entities"], "", ctx);

  if (config.schemaVersion !== undefined && config.schemaVersion !== SCHEMA_VERSION) {
    ctx.err("schemaVersion", `Unsupported schemaVersion (this server supports ${SCHEMA_VERSION})`);
  }

  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    auth: validateAuth(config.auth, ctx),
    connection: validateConnection(config.connection, ctx),
    entities: {},
  };

  const entities = config.entities === undefined || config.entities === null ? {} : config.entities;
  if (!isObj(entities)) ctx.err("entities", "Must be an object keyed by entity name");
  else {
    for (const [name, ent] of Object.entries(entities)) {
      const path = `entities.${name}`;
      const def = ENTITIES[name];
      if (!def) { ctx.err(path, `Unknown entity (allowed: ${Object.keys(ENTITIES).join(", ")})`); continue; }
      if (!isObj(ent)) { ctx.err(path, "Must be an object"); continue; }
      checkKeys(ent, def.sourceOnly ? ["enabled", "source"] : ["enabled", "source", "mapping", "filter"], path, ctx);

      const enabled = ent.enabled !== false;
      const out = { enabled };

      // A disabled entity is stored as-is-but-checked lightly, so a draft
      // config can be saved before every entity is finished.
      if (enabled) {
        if (!isObj(ent.source)) ctx.err(`${path}.source`, "Required object");
        else out.source = SOURCE_VALIDATORS[protocol](ent.source, `${path}.source`, ctx);
        if (!def.sourceOnly) {
          out.mapping = validateMapping(name, ent.mapping, `${path}.mapping`, ctx);
          out.filter = validateFilters(ent.filter, `${path}.filter`, ctx);
        }
      } else {
        if (ent.source !== undefined) out.source = ent.source;
        if (ent.mapping !== undefined) out.mapping = ent.mapping;
        if (ent.filter !== undefined) out.filter = ent.filter;
      }
      normalized.entities[name] = out;
    }
  }

  // Cross-entity sanity.
  const on = (n) => normalized.entities[n]?.enabled === true;
  if (on("DOCUMENT_CONTENT") && !on("DOCUMENT")) ctx.warn("entities.DOCUMENT_CONTENT", "Content download is enabled but DOCUMENT is not — nothing will trigger it");
  if (on("CATEGORY") && !on("DEPARTMENT")) ctx.warn("entities.CATEGORY", "Categories reference departments, but DEPARTMENT sync is disabled");
  if (on("DOCUMENT_TYPE") && !on("CATEGORY")) ctx.warn("entities.DOCUMENT_TYPE", "Document types reference categories, but CATEGORY sync is disabled");

  return { valid: ctx.errors.length === 0, errors: ctx.errors, warnings: ctx.warnings, normalized };
}

/** What can this connector actually do? Drives which tenant pages/buttons show. */
function computeCapabilities(config) {
  const on = (n) => config?.entities?.[n]?.enabled === true;
  return {
    masters: on("DEPARTMENT") || on("CATEGORY") || on("DOCUMENT_TYPE"),
    documents: on("DOCUMENT"),
    contentDownload: on("DOCUMENT_CONTENT"),
    entities: Object.keys(ENTITIES).filter(on),
  };
}

/** Sync-ready = at least one entity is enabled. */
function isSyncReady(config) {
  const c = computeCapabilities(config);
  return c.masters || c.documents;
}

const SAMPLE_SOURCE = {
  REST: (p) => ({ method: "GET", path: p, recordsPath: "$.data", pagination: { type: "NONE" } }),
  ODATA: (p) => ({ entitySet: p, pageSize: 500 }),
  SOAP: (p) => ({
    path: "/service", action: p,
    envelope: '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>',
    recordsPath: "$.Envelope.Body.Response.Item",
  }),
  DATABASE: (p) => ({ driver: "postgres", connection: { host: "db.example.com", port: 5432, database: "erp" }, query: `SELECT * FROM ${p}` }),
  FILE: (p) => ({ transport: "SFTP", connection: { host: "sftp.example.com", port: 22 }, path: `/export/${p}`, filePattern: "*.csv", format: "CSV" }),
  WEBHOOK: () => ({ recordsPath: "$.records", signatureType: "HMAC_SHA256" }),
};
const SAMPLE_NAME = {
  REST: { DEPARTMENT: "/departments", CATEGORY: "/categories", DOCUMENT_TYPE: "/document-types", DOCUMENT: "/documents", DOCUMENT_CONTENT: "/documents/{externalId}/content" },
  ODATA: { DEPARTMENT: "DepartmentSet", CATEGORY: "CategorySet", DOCUMENT_TYPE: "DocumentTypeSet", DOCUMENT: "DocumentMetaSet", DOCUMENT_CONTENT: "DocumentContentSet" },
};

/** Starter skeleton (all entities disabled) for the "new ERP" screen. */
function defaultConnectorConfig(protocol) {
  if (!PROTOCOLS.includes(protocol)) throw new Error(`Unknown protocol: ${protocol}`);
  const entities = {};
  for (const [name, def] of Object.entries(ENTITIES)) {
    const hint = (SAMPLE_NAME[protocol] || {})[name] || name.toLowerCase();
    const ent = { enabled: false, source: SAMPLE_SOURCE[protocol](hint) };
    if (!def.sourceOnly) {
      ent.mapping = {
        fields: Object.fromEntries(
          Object.entries(def.fields).filter(([, m]) => m.required).map(([f]) => [f, { from: `$.${f}` }]),
        ),
      };
      ent.filter = [];
    }
    entities[name] = ent;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    auth: { type: "NONE" },
    connection: { timeoutMs: 60000, verifyTls: true, headers: {}, retry: { maxAttempts: 2, backoffMs: 1000 } },
    entities,
  };
}

/** Vocabulary for the Super Admin UI (Step 3) — served by GET /erp-configs/connector-schema. */
function describeSchema() {
  return {
    schemaVersion: SCHEMA_VERSION,
    protocols: PROTOCOLS,
    authTypes: AUTH_TYPES,
    paginationTypes: PAGINATION_TYPES,
    filterOps: FILTER_OPS,
    transformOps: TRANSFORM_OPS,
    dbDrivers: DB_DRIVERS,
    fileTransports: FILE_TRANSPORTS,
    fileFormats: FILE_FORMATS,
    entities: Object.fromEntries(
      Object.entries(ENTITIES).map(([k, v]) => [k, {
        label: v.label,
        sourceOnly: !!v.sourceOnly,
        fields: Object.fromEntries(Object.entries(v.fields).map(([f, m]) => [f, { required: !!m.required }])),
      }]),
    ),
  };
}

/** erpType is now free text (Oracle, Odoo, NetSuite…) — normalise + validate. */
const ERP_TYPE_RE = /^[A-Z][A-Z0-9_]{1,49}$/;
function normalizeErpType(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return ERP_TYPE_RE.test(v) ? v : null;
}

/** SAP keeps its dedicated OData engine; everything else defaults to REST. */
function defaultProtocolFor(erpType) {
  return erpType === "SAP" ? "ODATA" : "REST";
}

module.exports = {
  SCHEMA_VERSION, PROTOCOLS, AUTH_TYPES, ENTITIES, TRANSFORM_OPS, FILTER_OPS,
  validateConnectorConfig, computeCapabilities, isSyncReady,
  defaultConnectorConfig, describeSchema, normalizeErpType, defaultProtocolFor,
};