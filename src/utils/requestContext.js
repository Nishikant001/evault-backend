// src/utils/requestContext.js
//
// Small helper that builds a consistent "who did this, from where" context
// object out of an Express request. Used by AuditService internally, and
// exposed for controllers that want to inspect/attach extra fields (e.g.
// oldValue/newValue) before calling AuditService.log().

const { parseUserAgent, resolveIpAddress } = require("./deviceParser");

/**
 * @param {import('express').Request} req
 * @returns {{
 *   userId: number|null,
 *   role: string|null,
 *   tenantId: number|null,
 *   ipAddress: string,
 *   browser: string,
 *   device: string,
 *   operatingSystem: string
 * }}
 */
function getRequestContext(req) {
  const reqUser = req?.user || {};
  const deviceInfo = parseUserAgent(req?.headers?.["user-agent"]);

  return {
    userId: reqUser.id ?? null,
    role: reqUser.role ?? null,
    tenantId: reqUser.tenantId ?? null,
    ipAddress: resolveIpAddress(req),
    browser: deviceInfo.browser,
    device: deviceInfo.device,
    operatingSystem: deviceInfo.operatingSystem,
  };
}

module.exports = { getRequestContext };
