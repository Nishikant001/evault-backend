// src/middleware/tenantResolverMiddleware.js
//
// PHASE E — turns a JWT-verified identity into the actual physical
// database connection request handlers should read/write.
//
// PHASE G — the legacy shared-DB fallback that used to live here has
// been REMOVED (brief STEP 2). Final behavior, no exceptions:
//   Master DB -> Tenant -> TenantDatabase -> Tenant connection
// If any link in that chain is missing, this returns 503. It never
// silently reads/writes the old shared database again.
//
// PHASE H — EXTENDED (not duplicated) for wildcard subdomain routing:
// req.hostContext (set by hostContextMiddleware.js, mounted globally
// before this one ever runs) is now cross-checked against the verified
// JWT's tenantId. A request that arrived on tenant 43's subdomain but
// carries a valid JWT for tenant 42 is rejected here with 403 — the
// hostname is never trusted as the SOURCE of tenant identity for an
// authenticated request (the JWT still is, exactly as before this
// phase); the hostname is only ever a CHECK against it. See
// hostContextMiddleware.js's header comment for the full split of
// responsibilities between the two middlewares.
//
// Composed from authMiddleware.js (see that file's header comment for
// why), not applied as a second stand-alone route-level middleware —
// every route already using authMiddleware gets tenant resolution
// automatically, with no per-route-file changes required.
//
// SECURITY: tenantId is read ONLY from the verified JWT payload
// (req.user.tenantId, set by authMiddleware from the signed token) —
// never from req.params, req.body, or req.query. The hostname-derived
// tenantId (req.hostContext) is likewise never itself trusted as an
// identity source for an authenticated request — see above.
const { getTenantConnection, TenantProvisioningError } = require("../services/tenantConnectionManager");
const masterModels = require("../models/masterDb");
const { structuredLog } = require("./requestContextMiddleware");

async function tenantResolverMiddleware(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // ── SuperAdmin: Master DB only, no tenant database involved.
    // "Do not force SuperAdmin through tenant resolution" (brief) — this
    // bypass is unconditional, regardless of which hostname the request
    // arrived on (e.g. admin.<domain> or a tenant subdomain by mistake). ──
    if (req.user.role === "SuperAdmin") {
      req.masterModels = masterModels;
      return next();
    }

    // ── Tenant user: resolve tenantId from the VERIFIED JWT, never
    // from client-supplied request data (see file header). ──────────
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      return res.status(403).json({ success: false, message: "User has no tenant assigned" });
    }

    // ── PHASE H — hostname/JWT cross-check. Only applies when this
    // request actually arrived on a resolved tenant subdomain
    // (req.hostContext.type === "tenant"); requests on a non-subdomain
    // host (bare API domain, BASE_DOMAIN not configured, etc.) are
    // unaffected — JWT-only resolution continues exactly as before this
    // phase, preserving any client that doesn't use tenant subdomains. ──
    if (req.hostContext?.type === "tenant" && req.hostContext.tenantId !== tenantId) {
      structuredLog({
        requestId: req.requestId,
        event: "host_jwt_tenant_mismatch",
        host: req.hostname,
        tenantSlug: req.hostContext.slug,
        tenantId,
        route: req.originalUrl,
        status: 403,
      });
      return res.status(403).json({ success: false, message: "Forbidden: token does not belong to this tenant workspace" });
    }

    const tenant = await masterModels.Tenant.findByPk(tenantId);

    // PHASE G: no legacy fallback. An unknown tenantId is a 503, not a
    // silent read against the old shared database.
    if (!tenant) {
      return res.status(503).json({
        success: false,
        message: "Tenant workspace is unavailable — no master tenant record found. Contact support if this persists.",
      });
    }
    if (tenant.status !== "ACTIVE") {
      return res.status(403).json({ success: false, message: `Tenant is ${tenant.status.toLowerCase()}` });
    }

    const tenantDb = await masterModels.TenantDatabase.findOne({ where: { tenantId } });

    // PHASE G: a missing or not-READY TenantDatabase is a 503 — never a
    // silent fallback to the old shared database (brief STEP 2).
    if (!tenantDb || tenantDb.status !== "READY") {
      return res.status(503).json({
        success: false,
        message: tenantDb
          ? `Tenant workspace is not ready (status: ${tenantDb.status})`
          : "Tenant workspace is unavailable — no tenant database is provisioned for this tenant.",
      });
    }

    let conn;
    try {
      conn = await getTenantConnection(tenantId);
    } catch (err) {
      if (err instanceof TenantProvisioningError) {
        return res.status(503).json({ success: false, message: err.message });
      }
      throw err;
    }

    // Don't trust the JWT's userId blindly either: a token issued before
    // the user was deactivated, or for a user who has since been
    // removed, should stop working the moment that's true in the
    // tenant's OWN database — not remain valid for the token's lifetime.
    const userRow = await conn.models.User.findByPk(req.user.id);
    if (!userRow || !userRow.isActive) {
      return res.status(401).json({ success: false, message: "User is no longer valid for this tenant" });
    }

    req.tenant = tenant;
    req.tenantDb = tenantDb;
    req.models = conn.models;
    req.masterModels = masterModels;

    console.log("[RESOLVER] set req.models?", !!req.models, "keys:", req.models ? Object.keys(req.models).slice(0, 5) : null, "route:", req.originalUrl);

    structuredLog({
      requestId: req.requestId,
      event: "tenant_resolved",
      host: req.hostname,
      tenantSlug: req.hostContext?.slug ?? null,
      tenantId,
      route: req.originalUrl,
    });

    return next();
  } catch (error) {
    // PHASE H — never expose database name, password, SQL, or a stack
    // trace to the client (brief "Errors"). The real error is logged
    // server-side only, via console.error (not structuredLog's
    // whitelisted fields — this is an operational error, not a routing
    // decision) so it's still fully debuggable without ever reaching
    // the response body.
    console.error(`[tenantResolverMiddleware] requestId=${req.requestId}`, error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = tenantResolverMiddleware;