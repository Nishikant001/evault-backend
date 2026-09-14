// src/middleware/requestContextMiddleware.js
//
// PHASE H — assigns a per-request correlation id (req.requestId) as
// early as possible in the stack (mounted first in app.js, before host
// resolution, before routes) so every subsequent log line — host
// resolution, auth, controller errors — can be tied together.
//
// Also exposes structuredLog(), the ONE logging helper used for the
// fields the brief requires (requestId, host, tenantSlug, tenantId,
// route) so there is a single place that enforces what must NEVER be
// logged: JWT/tokens, passwords, database credentials, document
// contents. Do not log req.headers.authorization, req.body, or any
// model instance directly anywhere in this codebase — pass only the
// specific primitive fields structuredLog() accepts.
const { randomUUID } = require("crypto");

function requestContextMiddleware(req, res, next) {
  req.requestId = req.headers["x-request-id"] || randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

/**
 * @param {object} fields
 * @param {string} fields.requestId
 * @param {string} [fields.host]
 * @param {string|null} [fields.tenantSlug]
 * @param {number|null} [fields.tenantId]
 * @param {string} [fields.route]
 * @param {string} [fields.event] - short event name, e.g. "tenant_resolved", "tenant_denied"
 * @param {number} [fields.status] - HTTP status, when logging a denial
 */
function structuredLog(fields) {
  // Whitelist fields explicitly — this function can never accidentally
  // leak a caller's extra object properties (JWT, password, req.body,
  // model instances, ...) that might get spread into it by mistake,
  // because it never accepts or forwards an arbitrary object.
  const safe = {
    ts: new Date().toISOString(),
    requestId: fields.requestId,
    event: fields.event,
    host: fields.host,
    tenantSlug: fields.tenantSlug ?? null,
    tenantId: fields.tenantId ?? null,
    route: fields.route,
    status: fields.status,
  };
  console.log(JSON.stringify(safe));
}

module.exports = { requestContextMiddleware, structuredLog };
