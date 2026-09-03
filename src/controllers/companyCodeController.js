// src/controllers/companyCodeController.js
//
// Phase 5: CompanyCode/Plant are per-tenant models now, read through
// req.models. The old Tenant.findByPk() existence check is gone —
// Phase 4's authMiddleware/tenantResolverMiddleware already validated
// the calling tenant exists and is ACTIVE before this code ever runs,
// so re-checking it here (against a model that isn't even in this
// database anymore) was redundant.
//
// SuperAdmin cross-tenant creation (pass tenantId to create/list under
// ANY tenant) is deferred to Phase 7 — same pattern as userController/
// categoryController: req.models is scoped to whichever tenant the
// CALLER belongs to, and SuperAdmin has none of their own (see
// authMiddleware.js's SuperAdmin bridge).

function resolveTenantId(req) {
  if (req.user.role === "SuperAdmin") {
    return null; // see header comment — cross-tenant not yet supported
  }
  return req.user.tenantId;
}

// ─────────────────────────────────────────────────────────────
// POST /api/company-codes
// ─────────────────────────────────────────────────────────────
const createCompanyCode = async (req, res) => {
  try {
    if (req.user.role === "SuperAdmin") {
      return res.status(501).json({
        success: false,
        message: "Cross-tenant company code creation is not yet available for SuperAdmin — coming in the Super Admin control plane phase.",
      });
    }

    const { CompanyCode } = req.models;
    const { code, name, description } = req.body;
    const tenantId = req.user.tenantId;

    if (!code || !name) {
      return res.status(400).json({
        success: false,
        message: "code and name are required",
      });
    }

    const companyCode = await CompanyCode.create({
      tenantId,
      code: code.trim().toUpperCase(),
      name: name.trim(),
      description,
    });

    return res.status(201).json({ success: true, data: companyCode });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "Company code already exists for this tenant",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/company-codes
// ─────────────────────────────────────────────────────────────
const listCompanyCodes = async (req, res) => {
  try {
    if (req.user.role === "SuperAdmin") {
      return res.status(501).json({
        success: false,
        message: "Cross-tenant company code listing is not yet available for SuperAdmin — coming in the Super Admin control plane phase.",
      });
    }

    const { CompanyCode } = req.models;
    const companyCodes = await CompanyCode.findAll({
      where: { tenantId: req.user.tenantId, status: "ACTIVE" },
      order: [["name", "ASC"]],
    });

    return res.json({ success: true, count: companyCodes.length, data: companyCodes });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/company-codes/:id
// ─────────────────────────────────────────────────────────────
const getCompanyCode = async (req, res) => {
  try {
    const { CompanyCode } = req.models;
    const { id } = req.params;

    const companyCode = await CompanyCode.findOne({ where: { id, tenantId: req.user.tenantId } });
    if (!companyCode) {
      return res.status(404).json({ success: false, message: "Company code not found" });
    }

    return res.json({ success: true, data: companyCode });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/company-codes/:id
// ─────────────────────────────────────────────────────────────
const updateCompanyCode = async (req, res) => {
  try {
    const { CompanyCode } = req.models;
    const { id } = req.params;

    const companyCode = await CompanyCode.findOne({ where: { id, tenantId: req.user.tenantId } });
    if (!companyCode) {
      return res.status(404).json({ success: false, message: "Company code not found" });
    }

    const { code, name, description, status } = req.body;
    await companyCode.update({ code, name, description, status });

    return res.json({ success: true, data: companyCode });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "Company code already exists for this tenant",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/company-codes/:id — soft delete, blocked if active plants exist
// ─────────────────────────────────────────────────────────────
const deleteCompanyCode = async (req, res) => {
  try {
    const { CompanyCode, Plant } = req.models;
    const { id } = req.params;

    const companyCode = await CompanyCode.findOne({ where: { id, tenantId: req.user.tenantId } });
    if (!companyCode) {
      return res.status(404).json({ success: false, message: "Company code not found" });
    }

    const activePlantCount = await Plant.count({
      where: { companyCodeId: companyCode.id, status: "ACTIVE" },
    });

    if (activePlantCount > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete company code with active plants. Remove/deactivate plants first.",
      });
    }

    await companyCode.update({ status: "INACTIVE" });
    return res.json({ success: true, message: "Company code deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createCompanyCode,
  listCompanyCodes,
  getCompanyCode,
  updateCompanyCode,
  deleteCompanyCode,
};
