const MasterDataService = require("../services/masterDataService");
const { resolveEntitySet } = require("../services/sapEntityResolver");

// Resolves this tenant's ErpConfig directly — Phase 5: ErpConfig is a
// per-tenant model now (Phase 2), and Tenant (master) no longer has a
// live association to it (they're in different physical databases). A
// tenant database only ever has ONE ErpConfig row in practice, so a
// direct findOne() replaces the old Tenant.findByPk(...).ErpConfig join.
//
// NOTE: documentController.js and sapFinalizationService.js each still
// have their OWN copy of this exact broken pattern (Tenant.findByPk with
// an ErpConfig include) — not fixed here since those files are still
// mid-conversion / part of the SAP subsystem's own dedicated slice, but
// they need the identical fix when their turn comes.
async function getErpConfigForTenant(masterModels, tenantId) {
  const { Tenant, ErpConfig } = masterModels;
  const tenant = await Tenant.findByPk(tenantId, { include: [{ model: ErpConfig }] });

  if (!tenant || !tenant.ErpConfig) {
    throw new Error("ERP configuration not assigned to tenant");
  }
  return tenant.ErpConfig;
}

class MasterDataController {
  static async departments(req, res) {
    try {
      const erpConfig = await getErpConfigForTenant(req.masterModels, req.user.tenantId);
      const data = await MasterDataService.getData(erpConfig, resolveEntitySet(erpConfig, "DEPARTMENT"));
      return res.json({ success: true, data });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async categories(req, res) {
    try {
      const erpConfig = await getErpConfigForTenant(req.masterModels, req.user.tenantId);
      const data = await MasterDataService.getData(erpConfig, resolveEntitySet(erpConfig, "CATEGORY"));
      return res.json({ success: true, data });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = MasterDataController;