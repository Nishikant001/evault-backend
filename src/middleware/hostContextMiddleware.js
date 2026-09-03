// src/middleware/hostContextMiddleware.js
//
// PHASE H — WILDCARD SUBDOMAIN TENANT ROUTING, step 1: hostname -> tenant
// IDENTITY (never a database connection by itself — see file-bottom note).
//
// Mounted ONCE, globally, before all routes (src/app.js) — this is NOT a
// duplicate of tenantResolverMiddleware.js's job. The two middlewares
// now have a clean, non-overlapping split of the SAME overall resolver
// the brief describes extending:
//
//   hostContextMiddleware   (this file, runs on EVERY request):
//     Host header -> tenant slug -> Master DB Tenant/TenantDatabase
//     lookup -> req.hostContext. Runs whether or not the request is
//     authenticated, because an unknown/inactive/unready tenant
//     SUBDOMAIN is a routing-level fact ("this whole hostname doesn't
//     work"), independent of who's asking.
//
//   tenantResolverMiddleware (extended this phase, runs only on
//   authenticated routes via authMiddleware):
//     JWT tenantId -> Master DB -> TenantDatabase -> tenant CONNECTION,
//     now ALSO cross-checked against req.hostContext (see that file) so
//     a valid JWT for tenant 42 can never be used against tenant 43's
//     subdomain.
//
// Request flow this implements (brief):
//   Host -> tenant slug -> Master DB -> tenants -> tenantId ->
//   tenant_databases -> tenant database -> existing tenant connection
//   manager -> existing controllers/services/repositories
// (the last two steps happen in tenantResolverMiddleware / the
// connection cache, unchanged — this file stops at "tenantId".)
//
// req.hostContext shapes:
//   { type: "disabled" }               - BASE_DOMAIN not configured; no-op everywhere
//   { type: "non-tenant" }             - apex domain / BASE_DOMAIN itself / unrelated host
//   { type: "reserved", slug }         - a reserved word used as a subdomain (never a tenant)
//   { type: "tenant", slug, tenantId, tenant, tenantDb } - resolved, ACTIVE, READY tenant
//
// SECURITY: the slug is validated as a safe DNS-label shape BEFORE it is
// ever used in a query (src/config/tenantRouting.js SLUG_PATTERN) — the
// Host header is attacker-controlled input. Errors never include the
// database name, credentials, SQL, or a stack trace (brief "Errors").
const masterModels = require("../models/masterDb");
const { BASE_DOMAIN, extractSlugCandidate, isAssignableSlug, RESERVED_SUBDOMAINS } = require("../config/tenantRouting");
const { structuredLog } = require("./requestContextMiddleware");

function deny(req, res, status, message, event) {
  structuredLog({
    requestId: req.requestId,
    event,
    host: req.hostname,
    tenantSlug: req.hostContext?.slug ?? null,
    tenantId: null,
    route: req.originalUrl,
    status,
  });
  return res.status(status).json({ success: false, message });
}

async function hostContextMiddleware(req, res, next) {
  try {
    if (!BASE_DOMAIN) {
      // Wildcard routing not configured for this environment — every
      // request behaves exactly as it did before this phase (JWT-only
      // tenant resolution via tenantResolverMiddleware). This is the
      // default for any deployment that hasn't set BASE_DOMAIN yet, so
      // this phase is purely additive and never breaks an existing
      // non-subdomain deployment.
      req.hostContext = { type: "disabled" };
      return next();
    }

    const hostname = req.hostname; // Express-parsed; honors `trust proxy` (see app.js) for X-Forwarded-Host
    const slugCandidate = extractSlugCandidate(hostname);

    if (!slugCandidate) {
      req.hostContext = { type: "non-tenant" };
      return next();
    }

    if (RESERVED_SUBDOMAINS.has(slugCandidate)) {
      // Reserved words never resolve as a tenant, on principle — even if
      // a Tenant row with a matching tenantCode somehow existed (defense
      // in depth; provisioning should also refuse to assign one, see
      // PHASE_H report). Treated as non-tenant, not an error: whatever
      // else this hostname is for (e.g. a static-asset subdomain routed
      // here by the reverse proxy) is out of this middleware's concern.
      req.hostContext = { type: "reserved", slug: slugCandidate };
      return next();
    }

    if (!isAssignableSlug(slugCandidate)) {
      // Syntactically invalid label (shouldn't normally reach here — a
      // real browser/DNS wouldn't produce this — but the Host header is
      // still attacker-controlled input over raw HTTP). Same response as
      // "unknown tenant": never reveal *why* a slug was rejected.
      return deny(req, res, 404, "Not found", "host_slug_invalid");
    }

    // ── Master DB lookup — the SAME natural key Phase F's migration
    // tooling and Phase G's tenant matching already use (tenantCode),
    // not a new column. See tenantRouting.js header for why uppercase. ──
    const tenant = await masterModels.Tenant.findOne({ where: { tenantCode: slugCandidate.toUpperCase() } });
    if (!tenant) {
      return deny(req, res, 404, "Unknown tenant", "host_tenant_unknown");
    }
    if (tenant.status !== "ACTIVE") {
      return deny(req, res, 403, `Tenant is ${String(tenant.status).toLowerCase()}`, "host_tenant_inactive");
    }

    const tenantDb = await masterModels.TenantDatabase.findOne({ where: { tenantId: tenant.id } });
    if (!tenantDb) {
      return deny(req, res, 503, "Tenant workspace is unavailable — no tenant database is provisioned for this tenant.", "host_tenantdb_missing");
    }
    if (tenantDb.status !== "READY") {
      return deny(req, res, 503, `Tenant workspace is not ready (status: ${tenantDb.status})`, "host_tenantdb_not_ready");
    }

    req.hostContext = { type: "tenant", slug: slugCandidate, tenantId: tenant.id, tenant, tenantDb };

    structuredLog({
      requestId: req.requestId,
      event: "host_tenant_resolved",
      host: hostname,
      tenantSlug: slugCandidate,
      tenantId: tenant.id,
      route: req.originalUrl,
    });

    return next();
  } catch (error) {
    // Never leak database name / credentials / SQL / stack trace.
    structuredLog({
      requestId: req.requestId,
      event: "host_resolution_error",
      host: req.hostname,
      route: req.originalUrl,
      status: 500,
    });
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = hostContextMiddleware;
