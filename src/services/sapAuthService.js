// src/services/sapAuthService.js
//
// SAP machine-to-machine authentication + tenant resolution.
//
// This is the ONLY place that turns a pair of SAP-supplied Basic Auth
// credentials into a resolved { tenant, erpConfig } pair. It exists
// separately from the middleware (sapVaultAuthMiddleware.js) so the
// resolution logic is unit-testable without an HTTP request, and so
// there is exactly one function any current/future SAP-inbound route
// needs to call.
//
// SECURITY / DESIGN NOTES
// ------------------------------------------------------------------
// - Tenant identity is derived EXCLUSIVELY from the verified username,
//   by walking the existing Master DB association
//   ErpConfig.hasMany(Tenant, { foreignKey: "erpConfigId" }). Nothing
//   here ever reads a tenantId from request body/query/params — there
//   is no such parameter in this module's signature at all, by design
//   (Requirements 10-12).
// - ErpConfig is a SHARED, platform-level record (one SAP landscape can
//   be assigned to many tenants). If more than one ACTIVE, ERP-enabled
//   tenant is currently assigned to the matched ErpConfig, tenant
//   identity is AMBIGUOUS from credentials alone — this fails closed
//   (AMBIGUOUS_TENANT) rather than guessing which tenant the call is
//   for. That is a configuration problem for a SuperAdmin to fix
//   (assign the SAP landscape's credentials to exactly one tenant, or
//   provision a dedicated ErpConfig per tenant), not something this
//   service should resolve silently.
// - erpConfig.password is compared using crypto.timingSafeEqual and is
//   NEVER included in any thrown error, return value, or log line.
//   Callers must not log the `password` argument either.
// - Every rejection path returns the SAME generic "Invalid SAP API
//   credentials" message for credential-shaped failures (missing ErpConfig
//   row, wrong password) so a caller cannot use response differences to
//   enumerate valid SAP usernames. Business-rule failures that occur
//   AFTER a credential match (ERP type, auth type, enablement, tenant
//   status, ambiguity) get their own distinct messages, since at that
//   point the caller has already proven knowledge of a valid
//   username/password pair.
"use strict";

const crypto = require("crypto");
const { verifySecret } = require("./erpCredentialService");

class SapAuthError extends Error {
  /**
   * @param {string} publicMessage - safe to return to the caller as-is
   * @param {number} status - HTTP status the middleware should send
   * @param {string} code - machine-readable reason, for server-side logging only
   */
  constructor(publicMessage, status, code) {
    super(publicMessage);
    this.name = "SapAuthError";
    this.publicMessage = publicMessage;
    this.status = status;
    this.code = code;
  }
}

/**
 * Constant-time string compare. Returns false (never throws) on length
 * mismatch, but still performs a same-cost dummy comparison so the
 * length check itself leaks as little timing signal as practical.
 */
function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a ?? ""), "utf8");
  const bBuf = Buffer.from(String(b ?? ""), "utf8");

  if (aBuf.length !== bBuf.length) {
    // Burn roughly the same amount of time as a real compare would,
    // without ever comparing the two real buffers against each other.
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify SAP Basic Auth credentials against the Master DB ErpConfig
 * table and resolve the single tenant they belong to.
 *
 * @param {Object} params
 * @param {string} params.username - decoded from the Authorization header ONLY
 * @param {string} params.password - decoded from the Authorization header ONLY
 * @param {Object} params.masterModels - the Master DB model registry (req.masterModels)
 * @returns {Promise<{ tenant: import("sequelize").Model, erpConfig: import("sequelize").Model }>}
 * @throws {SapAuthError}
 */
async function resolveSapTenantContext({ username, password, masterModels }) {
  if (!masterModels || !masterModels.ErpConfig || !masterModels.Tenant) {
    // Programmer error (middleware wired up wrong), not a caller-facing
    // auth failure — let the middleware's catch-all turn this into a 500.
    throw new Error("sapAuthService: masterModels.ErpConfig/Tenant not available");
  }

  if (!username || !password) {
    throw new SapAuthError("Invalid SAP API credentials", 401, "MISSING_CREDENTIALS");
  }

  const { ErpConfig, Tenant } = masterModels;

  // Username identifies WHICH SAP landscape (ErpConfig row) is calling.
  // Requirement 3: credentials come only from this DB lookup, never
  // from a request body parameter.
  const erpConfigs = await ErpConfig.findAll({
    where: { inboundUsername: username, erpType: "SAP" },
  });

  if (erpConfigs.length !== 1 || !verifySecret(password, erpConfigs[0].inboundPassword)) {
    throw new SapAuthError("Invalid SAP API credentials", 401, "BAD_CREDENTIALS");
  }

  const erpConfig = erpConfigs[0];

  // Requirement 7 — validate ERP type. This endpoint is SAP-specific;
  // an ErpConfig row for ORACLE/CUSTOM must never authenticate here even
  // if the username/password happen to match.
  if (erpConfig.erpType !== "SAP") {
    throw new SapAuthError("ERP configuration is not a SAP integration", 403, "INVALID_ERP_TYPE");
  }

  // This ErpConfig row must itself be configured for Basic Authentication.
  // (authType already models how OUR backend authenticates OUTBOUND to
  // SAP; reusing it here keeps a single source of truth for "this SAP
  // landscape's agreed auth mechanism is Basic" instead of introducing a
  // second, parallel auth-type flag.)
  if (erpConfig.integrationMode === "OUTBOUND") {
    throw new SapAuthError("ERP configuration is not enabled for inbound SAP Content API", 403, "INBOUND_DISABLED");
  }

  if (erpConfig.authType !== "BASIC") {
    throw new SapAuthError("ERP configuration is not enabled for Basic Authentication", 403, "AUTH_TYPE_MISMATCH");
  }

  if (!["ACTIVE", "CONNECTED"].includes(erpConfig.status)) {
    throw new SapAuthError("ERP configuration is not active", 403, "ERP_INACTIVE");
  }

  // Requirement 8 + 9 + 10 — resolve the tenant(s) this ErpConfig is
  // assigned to, filtered to erpEnabled=true and status=ACTIVE. tenantId
  // is derived ONLY from this query; it is never read from the request
  // (Requirements 11-12).
  const tenants = await Tenant.findAll({
    where: { erpConfigId: erpConfig.id, erpEnabled: true, status: "ACTIVE" },
  });

  if (tenants.length === 0) {
    throw new SapAuthError(
      "No active, ERP-enabled tenant is assigned to this ERP configuration",
      403,
      "NO_ACTIVE_TENANT"
    );
  }

  if (tenants.length > 1) {
    // Fail closed rather than guess. See module header note.
    throw new SapAuthError(
      "ERP configuration is assigned to more than one active tenant — resolve ambiguity in Master DB before use",
      409,
      "AMBIGUOUS_TENANT"
    );
  }

  return { tenant: tenants[0], erpConfig };
}

module.exports = { resolveSapTenantContext, SapAuthError, safeEqual };