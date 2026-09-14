// src/middleware/auditMiddleware.js
//
// Express middleware factory for fire-and-forget audit logging on a route.
// Usage (unchanged from before): auditMiddleware("LOGIN", "AUTH")
//
// Enhanced internally to write the full audit context (IP, browser,
// device, OS, actor identity) via AuditService, but the exported factory
// signature is 100% backward compatible with the original
// auditMiddleware(action, module) usage.

const AuditService = require("../services/auditService");
const { getRequestContext } = require("../utils/requestContext");

const auditMiddleware = (action, module, options = {}) => {
  return async (req, res, next) => {
    try {
      await AuditService.log({
        req,
        action,
        module,
        status: options.status,
        remarks: options.remarks,
      });
    } catch (error) {
      // Never block the request because audit logging failed.
      console.log("Audit Error:", error.message);
    }

    next();
  };
};

// Exposed so controllers can reuse the same IP/browser/device/OS
// extraction logic when they need to build a richer AuditService.log()
// call themselves (e.g. to attach oldValue/newValue).
auditMiddleware.getRequestContext = getRequestContext;

module.exports = auditMiddleware;
