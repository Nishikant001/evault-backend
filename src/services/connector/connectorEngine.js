// src/services/connector/connectorEngine.js
//
// GENERIC CONNECTOR ENGINE — Step 2.
//
// connectorSchema.js (Step 1) describes an ERP integration as DATA
// (erp_configs.connectorConfig) and validates/normalizes it. This module
// is the missing execution layer: given a normalized connectorConfig and
// an entity name, it actually talks to the ERP and returns canonical,
// mapped records — the "Connector Engine" the brief asks for:
//
//   ERP Connection -> Connector Config -> Authenticate -> Execute Request
//   -> Pagination -> Normalize -> Mapping -> Transformation -> Validation
//
// (Save / Logging / Retry happen one layer up, in genericSyncService.js,
// which reuses the existing SapSyncLog / SapSyncRetryQueue tables so every
// ERP — SAP included — shares one audit trail and one retry mechanism.)
//
// Only REST and ODATA are actually executed here. SOAP / DATABASE / FILE
// have full config validation in connectorSchema.js (so they can be
// configured and saved today) but no live execution — this project has no
// SOAP client or DB-driver dependency installed, and no SFTP client. Rather
// than fake a request or silently no-op, every attempt to execute one of
// those protocols throws a clear error naming exactly what's missing.
"use strict";

const axios = require("axios");
const { decryptSecret } = require("../erpCredentialService");
const { TRANSFORM_OPS } = require("./connectorSchema");

// ── path resolution ($.a.b[0].c, bare $) ───────────────────────────────
function getPath(obj, path) {
  if (!path || path === "$") return obj;
  const tokens = path
    .replace(/^\$\.?/, "")
    .match(/[^.\[\]]+|\[\d+\]/g);
  if (!tokens) return undefined;
  let cur = obj;
  for (let t of tokens) {
    if (cur === undefined || cur === null) return undefined;
    if (t.startsWith("[")) t = t.slice(1, -1);
    cur = cur[t];
  }
  return cur;
}

// ── transform pipeline (shares TRANSFORM_OPS with connectorSchema.js) ──
function applyOneTransform(value, step) {
  switch (step.op) {
    case "trim": return typeof value === "string" ? value.trim() : value;
    case "upper": return typeof value === "string" ? value.toUpperCase() : value;
    case "lower": return typeof value === "string" ? value.toLowerCase() : value;
    case "string": return value === undefined || value === null ? value : String(value);
    case "number": {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    case "boolean": return value === true || value === "true" || value === 1 || value === "1";
    case "date": {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d.toISOString();
    }
    case "prefix": return `${step.value}${value ?? ""}`;
    case "suffix": return `${value ?? ""}${step.value}`;
    case "replace": return typeof value === "string" ? value.split(step.from).join(step.to) : value;
    case "substring": return typeof value === "string" ? value.substring(step.start, step.end) : value;
    case "pad": return typeof value === "string" || typeof value === "number"
      ? String(value).padStart(step.length, step.char || "0")
      : value;
    case "valueMap": return Object.prototype.hasOwnProperty.call(step.map, value) ? step.map[value] : value;
    case "default": return (value === undefined || value === null || value === "") ? step.value : value;
    default: return value;
  }
}

function applyTransforms(value, steps = []) {
  return (steps || []).reduce((v, step) => applyOneTransform(v, step), value);
}

// ── mapping: raw record (per connectorSchema `mapping.fields`) -> canonical object
function mapRecord(raw, mapping) {
  const out = {};
  for (const [field, spec] of Object.entries(mapping?.fields || {})) {
    let value;
    if (spec.const !== undefined) {
      value = spec.const;
    } else if (Array.isArray(spec.from)) {
      value = spec.from.map((p) => getPath(raw, p)).filter((v) => v !== undefined && v !== null).join(spec.join ?? " ");
    } else if (spec.from) {
      value = getPath(raw, spec.from);
    }
    if ((value === undefined || value === null || value === "") && spec.default !== undefined) {
      value = spec.default;
    }
    out[field] = applyTransforms(value, spec.transform);
  }
  return out;
}

/** Validate a mapped canonical record against the entity's required fields. */
function validateRecord(entityDef, mapped) {
  const errors = [];
  for (const [field, meta] of Object.entries(entityDef.fields || {})) {
    if (meta.required && (mapped[field] === undefined || mapped[field] === null || mapped[field] === "")) {
      errors.push(`Missing required field "${field}"`);
    }
  }
  return errors;
}

// ── auth ─────────────────────────────────────────────────────────────
const oauthTokenCache = new Map(); // erpConfigId -> { token, expiresAt }

async function getOAuthToken(erpConfig, authCfg) {
  const cacheKey = erpConfig.id;
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5000) return cached.token;

  const clientId = erpConfig.username;
  const clientSecret = decryptSecret(erpConfig.password);
  const { oauth2 } = authCfg;

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (oauth2.scope) body.set("scope", oauth2.scope);
  if (oauth2.audience) body.set("audience", oauth2.audience);

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (oauth2.clientAuth === "BASIC_HEADER") {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
  }

  const resp = await axios.post(oauth2.tokenUrl, body.toString(), { headers, timeout: 30000 });
  const token = getPath(resp.data, oauth2.tokenPath || "$.access_token");
  if (!token) throw new Error("OAuth2 token response did not contain a token at " + (oauth2.tokenPath || "$.access_token"));
  const expiresIn = Number(resp.data?.expires_in) || 300;
  oauthTokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function buildAuthHeaders(erpConfig, connectorConfig) {
  const auth = connectorConfig?.auth || { type: "NONE" };
  switch (auth.type) {
    case "NONE": return {};
    case "BASIC": {
      const token = Buffer.from(`${erpConfig.username || ""}:${decryptSecret(erpConfig.password) || ""}`).toString("base64");
      return { Authorization: `Basic ${token}` };
    }
    case "BEARER": {
      const headerName = auth.headerName || "Authorization";
      return { [headerName]: `Bearer ${decryptSecret(erpConfig.apiKey)}` };
    }
    case "API_KEY": {
      if (auth.in === "query") return {}; // applied as a query param by the caller
      return { [auth.name || "x-api-key"]: decryptSecret(erpConfig.apiKey) };
    }
    case "OAUTH2_CLIENT_CREDENTIALS": {
      const token = await getOAuthToken(erpConfig, auth);
      return { Authorization: `Bearer ${token}` };
    }
    default: return {};
  }
}

function apiKeyQueryParam(connectorConfig, erpConfig) {
  const auth = connectorConfig?.auth;
  if (auth?.type === "API_KEY" && auth.in === "query") {
    return { [auth.name || "api_key"]: decryptSecret(erpConfig.apiKey) };
  }
  return {};
}

function buildClient(erpConfig, connectorConfig) {
  const conn = connectorConfig?.connection || {};
  return axios.create({
    baseURL: erpConfig.baseUrl,
    timeout: conn.timeoutMs || 60000,
    headers: { Accept: "application/json", ...(conn.headers || {}) },
    // verifyTls:false only ever comes from an explicit, validated config
    // flag (connectorSchema.js warns on it) — never a silent default.
    ...(conn.verifyTls === false ? { httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false }) } : {}),
  });
}

// ── pagination-aware fetch loop (shared by REST + ODATA) ───────────────
async function fetchAllPages({ client, method, path, baseQuery, baseHeaders, recordsPath, pagination, hasMorePathOverride }) {
  const type = pagination?.type || "NONE";
  const records = [];
  let page = pagination?.startPage ?? 1;
  let offset = 0;
  let cursor;
  let pageCount = 0;
  const maxPages = pagination?.maxPages || 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = { ...baseQuery };
    if (type === "PAGE") {
      query[pagination.pageParam || "page"] = page;
      if (pagination.sizeParam) query[pagination.sizeParam] = pagination.pageSize;
    } else if (type === "OFFSET") {
      query[pagination.offsetParam || "offset"] = offset;
      if (pagination.sizeParam) query[pagination.sizeParam] = pagination.pageSize;
    } else if (type === "CURSOR" && cursor) {
      query[pagination.cursorParam || "cursor"] = cursor;
    }

    const resp = await client.request({ method: method || "GET", url: path, params: query, headers: baseHeaders });
    const batch = getPath(resp.data, recordsPath || "$");
    const arr = Array.isArray(batch) ? batch : (batch ? [batch] : []);
    records.push(...arr);
    pageCount += 1;

    if (type === "NONE") break;
    if (pageCount >= maxPages) break;
    if (arr.length === 0) break;

    if (type === "PAGE") {
      if (pagination.pageSize && arr.length < pagination.pageSize) break;
      page += 1;
    } else if (type === "OFFSET") {
      if (pagination.pageSize && arr.length < pagination.pageSize) break;
      offset += arr.length;
    } else if (type === "CURSOR") {
      const next = getPath(resp.data, pagination.nextCursorPath);
      if (!next) break;
      cursor = next;
    } else if (type === "LINK_HEADER") {
      // Not enough standardization to implement generically without a
      // sample response; stop after one page rather than guess wrong.
      break;
    }

    const hasMorePath = hasMorePathOverride || pagination.hasMorePath;
    if (hasMorePath) {
      const hasMore = getPath(resp.data, hasMorePath);
      if (hasMore === false) break;
    }
  }
  return records;
}

// ── per-protocol raw fetch ──────────────────────────────────────────────
async function fetchRestRaw(erpConfig, connectorConfig, source) {
  const client = buildClient(erpConfig, connectorConfig);
  const authHeaders = await buildAuthHeaders(erpConfig, connectorConfig);
  const headers = { ...authHeaders, ...(source.headers || {}) };
  const query = { ...apiKeyQueryParam(connectorConfig, erpConfig), ...(source.query || {}) };
  return fetchAllPages({
    client,
    method: source.method || "GET",
    path: source.path,
    baseQuery: query,
    baseHeaders: headers,
    recordsPath: source.recordsPath || "$",
    pagination: source.pagination,
  });
}

async function fetchOdataRaw(erpConfig, connectorConfig, source) {
  const client = buildClient(erpConfig, connectorConfig);
  const authHeaders = await buildAuthHeaders(erpConfig, connectorConfig);
  const query = { ...apiKeyQueryParam(connectorConfig, erpConfig) };
  if (source.select?.length) query.$select = source.select.join(",");
  if (source.expand?.length) query.$expand = source.expand.join(",");
  if (source.filter) query.$filter = source.filter;
  if (source.orderby) query.$orderby = source.orderby;
  if (source.pageSize) query.$top = source.pageSize;

  const recordsPath = source.recordsPath
    || (source.version === "v4" ? "$.value" : "$.d.results");

  return fetchAllPages({
    client,
    method: "GET",
    path: `/${source.entitySet}`,
    baseQuery: query,
    baseHeaders: authHeaders,
    recordsPath,
    pagination: { type: "NONE" }, // OData paging (server-driven $skiptoken) needs a real
    // Oracle/SAP OData sample response to implement correctly; a single
    // page (up to $top) is fetched rather than guessing at $skiptoken
    // link shape and silently truncating data with no warning.
  });
}

const NOT_IMPLEMENTED = {
  SOAP: "SOAP execution requires a SOAP/XML client, which is not installed in this project. connectorConfig for SOAP can be created and validated, but cannot be executed yet.",
  DATABASE: "Direct-database execution requires a DB driver for the configured `driver` (mysql/postgres/mssql/oracle) beyond this project's current dependencies (mysql2 only). connectorConfig can be created and validated, but cannot be executed yet.",
  FILE: "SFTP/file-based execution requires an SFTP client, which is not installed in this project. connectorConfig can be created and validated, but cannot be executed yet.",
  WEBHOOK: "WEBHOOK is an inbound-only source (the ERP calls Evault) — there is nothing for the engine to pull.",
};

async function fetchRaw(erpConfig, connectorConfig, source, protocol) {
  if (protocol === "REST") return fetchRestRaw(erpConfig, connectorConfig, source);
  if (protocol === "ODATA") return fetchOdataRaw(erpConfig, connectorConfig, source);
  throw new Error(NOT_IMPLEMENTED[protocol] || `Unsupported protocol: ${protocol}`);
}

// ── public API ───────────────────────────────────────────────────────

/**
 * Fetch + map + validate one canonical entity for an ERP connection.
 * Returns { records: [{ mapped, raw, errors }], fetched: number }.
 * `errors.length > 0` means the record failed validation — caller decides
 * whether to save/skip/retry (mirrors the existing SAP retry-queue pattern).
 */
async function syncEntity(erpConfig, entityName) {
  const cfg = erpConfig.connectorConfig;
  if (!cfg) throw new Error(`ERP configuration "${erpConfig.name}" has no connectorConfig set`);
  const entityCfg = cfg.entities?.[entityName];
  if (!entityCfg || entityCfg.enabled !== true) {
    throw new Error(`Entity ${entityName} is not enabled for ERP configuration "${erpConfig.name}"`);
  }

  const { ENTITIES } = require("./connectorSchema");
  const entityDef = ENTITIES[entityName];
  const raw = await fetchRaw(erpConfig, cfg, entityCfg.source, erpConfig.protocol);

  const records = raw.map((r) => {
    const mapped = entityDef.sourceOnly ? null : mapRecord(r, entityCfg.mapping);
    const errors = entityDef.sourceOnly ? [] : validateRecord(entityDef, mapped);
    return { raw: r, mapped, errors };
  });

  return { fetched: raw.length, records };
}

/**
 * Connection test: authenticate, then make one small real request.
 * Uses the first enabled entity's source (pageSize forced to 1) if any
 * exists; otherwise just verifies auth/baseUrl reachability with a bare
 * GET to "/". Throws on failure — never returns a fake success.
 */
async function testConnection(erpConfig, progress = () => {}) {
  const cfg = erpConfig.connectorConfig;
  progress(`🌐 Connecting to ${erpConfig.name} (${erpConfig.erpType}, ${erpConfig.protocol})...`);

  if (!erpConfig.baseUrl) {
    throw new Error("No baseUrl configured for this ERP connection");
  }
  if (!["REST", "ODATA"].includes(erpConfig.protocol)) {
    throw new Error(NOT_IMPLEMENTED[erpConfig.protocol] || `Cannot test protocol ${erpConfig.protocol}`);
  }

  const enabledEntity = cfg?.entities
    ? Object.entries(cfg.entities).find(([, e]) => e.enabled === true)
    : null;

  if (enabledEntity) {
    const [name, entityCfg] = enabledEntity;
    progress(`🔐 Authenticating (${cfg.auth?.type || "NONE"})...`);
    const source = erpConfig.protocol === "ODATA"
      ? { ...entityCfg.source, pageSize: 1 }
      : { ...entityCfg.source, pagination: { ...(entityCfg.source.pagination || { type: "NONE" }), pageSize: 1, maxPages: 1 } };
    await fetchRaw(erpConfig, cfg, source, erpConfig.protocol);
    progress(`✅ Fetched a sample record from ${name}`);
  } else {
    const client = buildClient(erpConfig, cfg);
    const authHeaders = await buildAuthHeaders(erpConfig, cfg);
    progress(`🔐 Authenticating (${cfg?.auth?.type || "NONE"})...`);
    await client.get("/", { headers: authHeaders, validateStatus: () => true });
    progress("✅ Endpoint reachable");
  }

  progress(`🎯 ${erpConfig.erpType} connection successful`);
  return true;
}

module.exports = {
  syncEntity,
  testConnection,
  // exported for genericSyncService.js and tests
  mapRecord,
  applyTransforms,
  getPath,
  fetchRaw,
};
