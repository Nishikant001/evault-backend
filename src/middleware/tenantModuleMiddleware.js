const { assertTenantModule } = require("../services/tenantModuleService");

function requireTenantModule(moduleKey) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
      if (req.user.role === "SuperAdmin") return next();
      const tenantId = req.user.tenantId;
      if (!tenantId) return res.status(403).json({ success: false, message: "Tenant context required" });
      const result = await assertTenantModule(tenantId, moduleKey);
      if (!result.allowed) {
        return res.status(403).json({ success: false, code: "TENANT_MODULE_NOT_ENABLED", message: "This module is not enabled for your tenant" });
      }
      req.tenantModule = result.module;
      return next();
    } catch (error) {
      console.error(`[tenantModuleMiddleware] module=${moduleKey} requestId=${req.requestId || "-"}`, error);
      return res.status(500).json({ success: false, message: "Unable to verify module access" });
    }
  };
}

module.exports = { requireTenantModule };
