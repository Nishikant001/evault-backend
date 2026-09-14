// Deprecated compatibility middleware.
// The active SAP Content API uses sapVaultAuthMiddleware, which resolves
// credentials dynamically from Master DB ErpConfig and therefore supports
// different username/password pairs per ERP configuration.
"use strict";

module.exports = function deprecatedSapApiAuthMiddleware(req, res, next) {
  if (req.sapAuth) return next();
  return res.status(500).json({
    success: false,
    message: "Deprecated SAP API authentication middleware is not configured. Use sapVaultAuthMiddleware.",
  });
};
