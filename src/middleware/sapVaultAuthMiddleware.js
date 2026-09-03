// src/middleware/sapVaultAuthMiddleware.js
//
// SAP machine-to-machine authentication + tenant resolution for the
// SAP Vault API (POST /api/v1/vault/documents/upload and any future
// SAP-inbound routes mounted under /api/v1/vault).
//
// This is a DELIBERATELY SEPARATE stack from the portal's
// authMiddleware -> tenantResolverMiddleware chain:
//   - SAP is not a portal user: no JWT, no User row, no browser
//     session, no role, no subscription.
//   - This middleware never calls authMiddleware, roleMiddleware, or
//     subscriptionMiddleware, and must never be added to a router that
//     already uses them.
//   - It still ends up setting req.models / req.masterModels / req.tenant
//     the same shape tenantResolverMiddleware does, via the SAME
//     tenantConnectionManager, so downstream controllers can be written
//     the same way regardless of which auth path reached them.
//
// AUTHENTICATION FLOW
//   1. Require a well-formed `Authorization: Basic <base64(user:pass)>` header.
//   2. Decode it. Never accept SAP credentials from req.body/req.query.
//   3. Verify (username, password) against Master DB ErpConfig via
//      services/sapAuthService.js (constant-time password compare).
//   4. Validate ErpConfig.erpType === "SAP" and ErpConfig.authType === "BASIC".
//
// TENANT RESOLUTION FLOW
//   5. Resolve the tenant(s) assigned to that ErpConfig
//      (Tenant.erpConfigId), filtered to erpEnabled=true AND
//      status="ACTIVE". Exactly one match is required — zero or many
//      both fail closed. tenantId is NEVER taken from the request.
//   6. Reuse tenantConnectionManager.getTenantConnection(tenant.id) —
//      the SAME connection cache/pool the portal JWT path uses — to get
//      that tenant's physical database connection.
//   7. Attach req.tenant / req.models / req.masterModels / req.sapAuth.
//      A handler downstream can now only ever read/write the ONE
//      resolved tenant's database (Requirement 13) — there is no code
//      path here that lets the caller pick a different one.
//
// LOGGING
//   Only structuredLog()'s whitelisted fields are ever logged (event
//   name, tenantId, route, status) — see requestContextMiddleware.js.
//   The Authorization header, the decoded username/password, and the
//   ErpConfig password are NEVER passed to console.log/console.error or
//   structuredLog anywhere in this file.
"use strict";

const masterModels = require("../models/masterDb");
const { getTenantConnection, TenantProvisioningError } = require("../services/tenantConnectionManager");
const { resolveSapTenantContext, SapAuthError } = require("../services/sapAuthService");
const { structuredLog } = require("./requestContextMiddleware");

/**
 * Parse an HTTP Basic Authorization header value.
 * @returns {{username: string, password: string} | null}
 */
function parseBasicAuthHeader(authHeader) {
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return null;
  }

  const encoded = authHeader.slice("Basic ".length).trim();

  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

async function sapVaultAuthMiddleware(req, res, next) {
  try {
    const credentials = parseBasicAuthHeader(req.headers.authorization);

    if (!credentials) {
      res.setHeader("WWW-Authenticate", 'Basic realm="SAP Vault API"');
      structuredLog({
        requestId: req.requestId,
        event: "sap_vault_auth_header_missing_or_malformed",
        route: req.originalUrl,
        status: 401,
      });
      return res.status(401).json({
        success: false,
        message: "SAP API authentication required",
      });
    }

    let resolved;
    try {
      resolved = await resolveSapTenantContext({
        username: credentials.username,
        password: credentials.password,
        masterModels,
      });
    } catch (err) {
      if (err instanceof SapAuthError) {
        structuredLog({
          requestId: req.requestId,
          event: `sap_vault_auth_denied_${err.code.toLowerCase()}`,
          route: req.originalUrl,
          status: err.status,
        });
        return res.status(err.status).json({ success: false, message: err.publicMessage });
      }
      throw err;
    }

    const { tenant, erpConfig } = resolved;

    // Reuse the SAME tenant connection cache the portal JWT path uses —
    // this is the existing Master DB -> TenantDatabase -> physical
    // connection mechanism (Requirement 14), not a parallel one.
    let conn;
    try {
      conn = await getTenantConnection(tenant.id);
    } catch (err) {
      if (err instanceof TenantProvisioningError) {
        structuredLog({
          requestId: req.requestId,
          event: "sap_vault_tenant_db_unavailable",
          tenantId: tenant.id,
          route: req.originalUrl,
          status: 503,
        });
        return res.status(503).json({
          success: false,
          message: "Tenant workspace is unavailable — no tenant database is provisioned or ready.",
        });
      }
      throw err;
    }

    // req.user is intentionally NEVER set here — there is no portal
    // user, JWT, role, or subscription behind this request. Any
    // downstream code that assumes req.user exists must not be reused
    // on this route without review.
    req.tenant = tenant;
    req.models = conn.models;
    req.masterModels = masterModels;
    req.sapAuth = {
      erpConfigId: erpConfig.id,
      username: erpConfig.username, // identity only — password is never attached to req
      tenantId: tenant.id,
    };
    // PHASE — SAP Content API integration: expose the full resolved
    // ErpConfig row (entitySetMap/fieldMap/functionMap/etc.) so downstream
    // vault handlers can resolve field names dynamically via the SAME
    // architecture the OData sync uses (see sapEntityResolver.js), instead
    // of hardcoding this landscape's request body key spelling. Never
    // includes/exposes erpConfig.password — that field simply isn't read
    // anywhere downstream of this point.
    req.erpConfig = erpConfig;

    structuredLog({
      requestId: req.requestId,
      event: "sap_vault_auth_success",
      tenantId: tenant.id,
      route: req.originalUrl,
    });

    return next();
  } catch (error) {
    // Never expose internal error details, SQL, or stack traces to the
    // caller. Server-side log intentionally omits req.headers.authorization
    // and any credential value — only the error message is logged.
    console.error(`[sapVaultAuthMiddleware] requestId=${req.requestId}:`, error.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = sapVaultAuthMiddleware;