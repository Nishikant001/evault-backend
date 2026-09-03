// src/controllers/healthController.js
//
// PRODUCTION DEPLOYMENT — health check endpoints.
//
// GET /health
//   Liveness + Master DB check. This is what a load balancer / Nginx /
//   orchestrator should poll. Never touches a tenant database (there is
//   no tenant context on a bare apex/API-domain request), and never
//   requires authentication — see brief "Health check: GET /health,
//   checks Node, Master DB".
//
// GET /health/tenant
//   Separate, OPTIONAL endpoint that additionally checks the CURRENT
//   tenant's database — only meaningful when the request arrives on a
//   tenant subdomain (req.hostContext.type === "tenant", set by
//   hostContextMiddleware, mounted globally in app.js). On a non-tenant
//   host it reports that clearly instead of guessing a tenant.
//
// Both endpoints return structured JSON only — no stack traces, no SQL,
// no database names/credentials (brief "Do not expose ... stack
// traces ... internal DB names").
const masterSequelize = require("../config/masterDatabase");
const { getTenantConnection } = require("../services/tenantConnectionManager");

const startedAt = Date.now();

async function health(req, res) {
  const result = {
    status: "ok",
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    node: "ok",
    masterDb: "unknown",
  };

  try {
    await masterSequelize.authenticate();
    result.masterDb = "ok";
  } catch (err) {
    result.masterDb = "error";
    result.status = "error";
  }

  const httpStatus = result.status === "ok" ? 200 : 503;
  return res.status(httpStatus).json(result);
}

async function tenantHealth(req, res) {
  const hostContext = req.hostContext;

  if (!hostContext || hostContext.type !== "tenant") {
    // Not an error in the sense of a broken system — this endpoint was
    // just called from a hostname that isn't a resolved tenant. Reported
    // as 400, not 500 (brief: never leak internals; this is a caller
    // usage detail, not a system failure).
    return res.status(400).json({
      status: "n/a",
      message: "This host is not a resolved tenant subdomain.",
    });
  }

  const result = {
    status: "ok",
    tenantSlug: hostContext.slug,
    tenantDb: "unknown",
  };

  try {
    const { sequelize } = await getTenantConnection(hostContext.tenantId);
    await sequelize.authenticate();
    result.tenantDb = "ok";
  } catch (err) {
    result.tenantDb = "error";
    result.status = "error";
  }

  const httpStatus = result.status === "ok" ? 200 : 503;
  return res.status(httpStatus).json(result);
}

module.exports = { health, tenantHealth };
