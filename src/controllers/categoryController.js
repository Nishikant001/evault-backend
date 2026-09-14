const { Op } = require("sequelize");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const userAssignmentService = require("../services/userAssignmentService");

// Helper: verify tenant has this department assigned
// `models` passed explicitly — this helper has no `req` of its own.
async function verifyTenantHasDept(masterModels, tenantId, departmentId) {
  const { TenantDepartment } = masterModels;
  const assignment = await TenantDepartment.findOne({
    where: { tenantId, departmentId, status: "ACTIVE" },
  });
  return !!assignment;
}

// ── Create a category under an assigned department ──────────
const createCategory = async (req, res) => {
  try {
    const { Category } = req.models;
    const { departmentId, name, description } = req.body;
    const tenantId = req.user.tenantId;

    if (!departmentId || !name) {
      return res.status(400).json({
        success: false,
        message: "departmentId and name are required",
      });
    }

    const hasAccess = await verifyTenantHasDept(req.masterModels, tenantId, departmentId);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "This department is not assigned to your tenant",
      });
    }

    const category = await Category.create({
      tenantId,
      departmentId,
      name: name.trim(),
      description,
    });

    // ── Audit: category created ─────────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.CATEGORY,
      action: AUDIT_ACTIONS.CATEGORY_CREATED,
      newValue: { id: category.id, name: category.name, departmentId },
      remarks: `Created category "${category.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({ success: true, data: category });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "Category with this name already exists in this department",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── List categories for a tenant (optionally filtered by dept) ─
// ── List categories for a tenant (optionally filtered by dept) ─
//
// PHASE G: Department is now a Master DB model (req.masterModels), while
// Category lives in the tenant DB (req.models). Sequelize can't `include`
// across two separate physical connections — same pattern used in
// departmentController.getDepartmentsByPlantInternal — so this runs as
// two queries and joins Department info onto each category in JS.
const listCategories = async (req, res) => {
  try {
    const { Category } = req.models;
    const { Department } = req.masterModels;
    const tenantId = req.user.tenantId;
    const { departmentId } = req.query;

    const where = { tenantId, status: "ACTIVE" };
    if (departmentId) where.departmentId = departmentId;

    const scope = await userAssignmentService.resolveScope(
      req.models,
      tenantId,
      req.user.id,
      req.user.role
    );
    if (scope) {
      if (!scope.categoryIds.length) {
        return res.json({ success: true, data: [] });
      }
      where.id = { [Op.in]: scope.categoryIds };
    }

    const categories = await Category.findAll({
      where,
      order: [["name", "ASC"]],
      raw: true,
    });

    const deptIds = [...new Set(categories.map((c) => c.departmentId).filter(Boolean))];
    const depts = deptIds.length
      ? await Department.findAll({
          where: { id: { [Op.in]: deptIds } },
          attributes: ["id", "name", "code"],
          raw: true,
        })
      : [];
    const deptById = new Map(depts.map((d) => [d.id, d]));

    const data = categories.map((c) => ({
      ...c,
      Department: deptById.get(c.departmentId) || null,
    }));

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Update a category ───────────────────────────────────────
const updateCategory = async (req, res) => {
  try {
    const { Category } = req.models;
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    const category = await Category.findOne({ where: { id, tenantId } });
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const oldValue = category.toJSON();
    await category.update(req.body);

    // ── Audit: category updated ─────────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.CATEGORY,
      action: AUDIT_ACTIONS.CATEGORY_UPDATED,
      oldValue,
      newValue: category.toJSON(),
      remarks: `Updated category "${category.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: category });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Delete (soft) a category ────────────────────────────────
const deleteCategory = async (req, res) => {
  try {
    const { Category } = req.models;
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    const category = await Category.findOne({ where: { id, tenantId } });
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    await category.update({ status: "INACTIVE" });

    // ── Audit: category deleted ─────────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.CATEGORY,
      action: AUDIT_ACTIONS.CATEGORY_DELETED,
      oldValue: { status: "ACTIVE" },
      newValue: { status: "INACTIVE" },
      remarks: `Deleted category "${category.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, message: "Category deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { createCategory, listCategories, updateCategory, deleteCategory };
