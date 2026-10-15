// src/controllers/plantController.js
//
// Phase 5: Plant/CompanyCode/TenantDepartmentPlant are per-tenant models
// now, read through req.models. SuperAdmin cross-tenant creation deferred
// to Phase 7 — same pattern as companyCodeController.js.

const userAssignmentService = require("../services/userAssignmentService");

function resolveTenantId(req) {
  if (req.user.role === "SuperAdmin") return null;
  return req.user.tenantId;
}

async function verifyCompanyCodeAccess(models, companyCodeId, tenantId) {
  const { CompanyCode } = models;
  return CompanyCode.findOne({ where: { id: companyCodeId, tenantId, status: "ACTIVE" } });
}

// ─────────────────────────────────────────────────────────────
// POST /api/plants
// ─────────────────────────────────────────────────────────────
const createPlant = async (req, res) => {
  try {
    if (req.user.role === "SuperAdmin") {
      return res.status(501).json({
        success: false,
        message: "Cross-tenant plant creation is not yet available for SuperAdmin — coming in the Super Admin control plane phase.",
      });
    }

    const { Plant } = req.models;
    const { companyCodeId, code, name, description } = req.body;
    const tenantId = req.user.tenantId;

    if (!companyCodeId || !code || !name) {
      return res.status(400).json({
        success: false,
        message: "companyCodeId, code and name are required",
      });
    }

    const companyCode = await verifyCompanyCodeAccess(req.models, companyCodeId, tenantId);
    if (!companyCode) {
      return res.status(403).json({
        success: false,
        message: "Company code not found or does not belong to your tenant",
      });
    }

    const plant = await Plant.create({
      tenantId,
      companyCodeId,
      code: code.trim().toUpperCase(),
      name: name.trim(),
      description,
    });

    return res.status(201).json({ success: true, data: plant });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "Plant code already exists under this company code",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/plants  (?companyCodeId=)
// ─────────────────────────────────────────────────────────────
const listPlants = async (req, res) => {
  try {
    if (req.user.role === "SuperAdmin") {
      return res.status(501).json({
        success: false,
        message: "Cross-tenant plant listing is not yet available for SuperAdmin — coming in the Super Admin control plane phase.",
      });
    }

    const { Plant, CompanyCode } = req.models;
    const { companyCodeId } = req.query;
    const tenantId = req.user.tenantId;

    const where = { tenantId, status: "ACTIVE" };
    if (companyCodeId) where.companyCodeId = companyCodeId;

    // Authorization: same rule as Company Codes above — a restricted
    // user only sees the Plant(s) mapped to their own assigned
    // department(s), never every plant in the tenant.
    const scope = await userAssignmentService.resolveScope(
      req.models,
      tenantId,
      req.user.id,
      req.user.role
    );
    if (scope) {
      const locationScope = await userAssignmentService.resolveLocationScope(
        req.models,
        tenantId,
        scope
      );
      if (!locationScope.plantIds.length) {
        return res.json({ success: true, count: 0, data: [] });
      }
      where.id = locationScope.plantIds;
    }

    const plants = await Plant.findAll({
      where,
      include: [{ model: CompanyCode, attributes: ["id", "code", "name"] }],
      order: [["name", "ASC"]],
    });

    return res.json({ success: true, count: plants.length, data: plants });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/plants/:id
// ─────────────────────────────────────────────────────────────
const getPlant = async (req, res) => {
  try {
    const { Plant, CompanyCode } = req.models;
    const { id } = req.params;

    const plant = await Plant.findOne({
      where: { id, tenantId: req.user.tenantId },
      include: [{ model: CompanyCode, attributes: ["id", "code", "name"] }],
    });

    if (!plant) {
      return res.status(404).json({ success: false, message: "Plant not found" });
    }

    return res.json({ success: true, data: plant });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/plants/:id
// ─────────────────────────────────────────────────────────────
const updatePlant = async (req, res) => {
  try {
    const { Plant } = req.models;
    const { id } = req.params;

    const plant = await Plant.findOne({ where: { id, tenantId: req.user.tenantId } });
    if (!plant) {
      return res.status(404).json({ success: false, message: "Plant not found" });
    }

    const { code, name, description, status } = req.body;
    await plant.update({ code, name, description, status });

    return res.json({ success: true, data: plant });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "Plant code already exists under this company code",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/plants/:id — soft delete, blocked if active dept mappings exist
// ─────────────────────────────────────────────────────────────
const deletePlant = async (req, res) => {
  try {
    const { Plant, TenantDepartmentPlant } = req.models;
    const { id } = req.params;

    const plant = await Plant.findOne({ where: { id, tenantId: req.user.tenantId } });
    if (!plant) {
      return res.status(404).json({ success: false, message: "Plant not found" });
    }

    const activeMappingCount = await TenantDepartmentPlant.count({
      where: { plantId: plant.id, status: "ACTIVE" },
    });

    if (activeMappingCount > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete plant with active department mappings. Remove/deactivate department mappings first.",
      });
    }

    await plant.update({ status: "INACTIVE" });
    return res.json({ success: true, message: "Plant deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createPlant,
  listPlants,
  getPlant,
  updatePlant,
  deletePlant,
};