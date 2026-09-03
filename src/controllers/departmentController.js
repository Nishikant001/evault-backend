// src/controllers/departmentController.js
//
// PHASE G — Department/TenantDepartment/Tenant are Master DB models
// (req.masterModels). Plant/CompanyCode/TenantDepartmentPlant are
// tenant-side (per-tenant physical database) — see
// PHASE_F_MIGRATION_REPORT.md section 1 for the full classification.
//
// SuperAdmin can call several of the tenant-scoped endpoints below with
// an explicit ?tenantId=/body.tenantId (see resolveTenantId()), so those
// paths resolve the TARGET tenant's own connection via
// getTenantConnection(tenantId) rather than req.models (which is only
// ever the CALLING user's own tenant, and is undefined for SuperAdmin).
// TenantAdmin-only paths use req.models directly since it's always the
// right connection there and avoids a redundant connection-cache lookup.
//
// Any place this file used to `include: [{ model: Department }]` on a
// TENANT-side model (TenantDepartmentPlant) has been split into two
// queries — one per database — with the join done in JS, since Sequelize
// cannot join across two separate physical database connections.
const { Op } = require("sequelize");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const { getTenantConnection } = require("../services/tenantConnectionManager");

// Helper: resolve the tenantId to operate on for tenant-scoped endpoints.
// TenantAdmin/others → always their own tenant.
// SuperAdmin → no tenant of their own, so they must pass tenantId explicitly
// (kept intentionally permissive/null-able for SuperAdmin cross-tenant admin reads).
function resolveTenantId(req) {
  if (req.user.role === "SuperAdmin") {
    return req.body?.tenantId || req.query?.tenantId || null;
  }
  return req.user.tenantId;
}

// Resolves the tenant-side model set to use for a given resolved
// tenantId: the caller's own req.models when it's their own tenant
// (cheap, already resolved by tenantResolverMiddleware), otherwise a
// fresh/cached lookup for the target tenant (SuperAdmin cross-tenant case).
async function resolveTenantModels(req, tenantId) {
  if (req.models && req.user.role !== "SuperAdmin") return req.models;
  const conn = await getTenantConnection(tenantId);
  return conn.models;
}

// ─────────────────────────────────────────────────────────────
// POST /api/departments
// SuperAdmin: Create a new department in master list
//
// NOTE: Department is a GLOBAL MASTER shared across every tenant it is
// assigned to. It intentionally has NO tenant-specific or plant-specific
// data on it (that previously included a `plantId` column which caused
// one tenant's plant assignment to silently overwrite another tenant's —
// see TenantDepartmentPlant.js for details). Plant assignment now always
// happens per-tenant via /api/departments/plant/:plantId below.
// ─────────────────────────────────────────────────────────────
const createDepartment = async (req, res) => {
  try {
    const { Department } = req.masterModels;
    const { name, code, description } = req.body;

    if (!name || !code) {
      return res.status(400).json({
        success: false,
        message: "name and code are required",
      });
    }

    const dept = await Department.create({
      name: name.trim(),
      code: code.trim().toUpperCase(),
      description,
      // plantId is intentionally never set here — Department must stay
      // plant-agnostic. Use POST /api/departments/plant/:plantId to map
      // this department to a specific Plant for a specific tenant.
    });

    // ── Audit: department created ───────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.DEPARTMENT,
      action: AUDIT_ACTIONS.DEPARTMENT_CREATED,
      department: dept.name,
      newValue: { id: dept.id, name: dept.name, code: dept.code },
      remarks: `Created department "${dept.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({ success: true, data: dept });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "Department name or code already exists",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/departments
// SuperAdmin + Admin: List all active departments from master
//
// Optional ?plantId= — when provided, this now resolves through the
// tenant-scoped TenantDepartmentPlant mapping table instead of the legacy
// (and no-longer-written-to) Department.plantId column, so the result is
// correctly scoped to the caller's own tenant (or ?tenantId= for SuperAdmin).
// ─────────────────────────────────────────────────────────────
const listDepartments = async (req, res) => {
  try {
    const { Department } = req.masterModels;
    const { plantId } = req.query;

    if (plantId) {
      const tenantId = resolveTenantId(req);
      return getDepartmentsByPlantInternal(req, res, plantId, tenantId);
    }

    const depts = await Department.findAll({
      where: { status: "ACTIVE" },
      order: [["name", "ASC"]],
    });

    return res.json({ success: true, count: depts.length, data: depts });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/departments/:id
// SuperAdmin: Update a department in master list
// ─────────────────────────────────────────────────────────────
const updateDepartment = async (req, res) => {
  try {
    const { Department } = req.masterModels;
    const { id } = req.params;

    const dept = await Department.findByPk(id);
    if (!dept) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    // Department is a global master — never allow plant-specific data to be
    // written onto it through this endpoint (see createDepartment note above).
    const oldValue = dept.toJSON();
    const { name, code, description, status } = req.body;
    await dept.update({ name, code, description, status });

    // ── Audit: department updated ───────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.DEPARTMENT,
      action: AUDIT_ACTIONS.DEPARTMENT_UPDATED,
      department: dept.name,
      oldValue,
      newValue: dept.toJSON(),
      remarks: `Updated department "${dept.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: dept });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "Department name or code already exists",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/departments/assign/:tenantId
// Admin: Assign one or more departments to a tenant
// Body: { departmentIds: [1, 2, 3] }
// ─────────────────────────────────────────────────────────────
const assignDepartmentsToTenant = async (req, res) => {
  try {
    const { Department, TenantDepartment, Tenant } = req.masterModels;
    const { tenantId } = req.params;
    const { departmentIds } = req.body;

    if (!Array.isArray(departmentIds) || departmentIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "departmentIds must be a non-empty array",
      });
    }

    // Verify tenant exists
    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: "Tenant not found",
      });
    }

    if (tenant.status !== "ACTIVE") {
      return res.status(400).json({
        success: false,
        message: "Cannot assign departments to an inactive tenant",
      });
    }

    // Verify all department IDs exist and are active
    const depts = await Department.findAll({
      where: {
        id: { [Op.in]: departmentIds },
        status: "ACTIVE",
      },
    });

    if (depts.length !== departmentIds.length) {
      return res.status(400).json({
        success: false,
        message: "One or more department IDs are invalid or inactive",
      });
    }

    // Upsert — skip duplicates silently
    const records = departmentIds.map((deptId) => ({
      tenantId:     parseInt(tenantId),
      departmentId: deptId,
      assignedBy:   req.user.id,
      status:       "ACTIVE",
    }));

    await TenantDepartment.bulkCreate(records, { ignoreDuplicates: true });

    return res.json({
      success: true,
      message: `${departmentIds.length} department(s) assigned to tenant successfully`,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/departments/tenant/:tenantId
// Admin: Get all active departments assigned to a tenant
// ─────────────────────────────────────────────────────────────
const getTenantDepartments = async (req, res) => {
  try {
    const { Department, TenantDepartment, Tenant } = req.masterModels;
    const { tenantId } = req.params;

    // Verify tenant exists
    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: "Tenant not found",
      });
    }

    const assignments = await TenantDepartment.findAll({
      where: { tenantId, status: "ACTIVE" },
      include: [
        {
          model: Department,
          where: { status: "ACTIVE" },
          attributes: ["id", "name", "code", "description"],
        },
      ],
    });

    // Filter out any null Departments (safety net)
    const depts = assignments
      .map((a) => a.Department)
      .filter(Boolean);

    return res.json({ success: true, count: depts.length, data: depts });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/departments/tenant/:tenantId/:departmentId
// Admin: Remove (soft delete) a department assignment from a tenant
// ─────────────────────────────────────────────────────────────
const removeDepartmentFromTenant = async (req, res) => {
  try {
    const { TenantDepartment } = req.masterModels;
    const { tenantId, departmentId } = req.params;

    const assignment = await TenantDepartment.findOne({
      where: { tenantId, departmentId },
    });

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Department assignment not found for this tenant",
      });
    }

    if (assignment.status === "INACTIVE") {
      return res.status(400).json({
        success: false,
        message: "Department is already removed from this tenant",
      });
    }

    await assignment.update({ status: "INACTIVE" });

    // Tenant no longer has this Department at all, so any Plant mappings
    // this tenant created for it are no longer valid either. Deactivate
    // them too — this never touches the global Department/TenantDepartment
    // rows of any OTHER tenant. TenantDepartmentPlant is tenant-side, so
    // this needs that tenant's OWN connection (never req.models blindly —
    // the caller may be SuperAdmin acting on someone else's tenant).
    const tenantModels = await resolveTenantModels(req, tenantId);
    await tenantModels.TenantDepartmentPlant.update(
      { status: "INACTIVE" },
      { where: { tenantId, departmentId, status: "ACTIVE" } }
    );

    return res.json({
      success: true,
      message: "Department removed from tenant successfully",
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/departments/:departmentId/tenants
// SuperAdmin: Get all tenants assigned to a specific department
const getTenantsForDepartment = async (req, res) => {
  try {
    const { Department, TenantDepartment, Tenant } = req.masterModels;
    const { departmentId } = req.params;

    const dept = await Department.findByPk(departmentId);
    if (!dept) {
      return res.status(404).json({ success: false, message: "Department not found" });
    }

    const assignments = await TenantDepartment.findAll({
      where: { departmentId },
      include: [
        {
          model: Tenant,
          attributes: ["id", "tenantName", "tenantCode", "status"],
        },
      ],
    });

    const data = assignments
      .filter(a => a.Tenant)
      .map(a => ({
        tenantId:      a.Tenant.id,
        tenantName:    a.Tenant.tenantName,
        tenantCode:    a.Tenant.tenantCode,
        status:        a.status,           // TenantDepartment assignment status
        assignedAt:    a.createdAt,
        employeeCount: a.employeeCount ?? 0,
      }));

    return res.json({ success: true, count: data.length, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/departments/plant/:plantId
// TenantAdmin / SuperAdmin(with tenantId): map an EXISTING global Department
// (already assigned to this tenant via TenantDepartment) to one of this
// tenant's own Plants.
//
// Body: { departmentId }  (SuperAdmin may also pass tenantId)
//
// This REPLACES the old behaviour of this endpoint, which used to create a
// brand new Department row and stamp `plantId` directly onto it — that was
// the root cause of tenant configuration leaking through shared global
// Department data (see TenantDepartmentPlant.js). The mapping created here
// lives entirely in `tenant_department_plants` and never mutates Department
// or TenantDepartment, so XYZ Tenant mapping "Finance" -> Plant A can never
// affect DEF Tenant mapping "Finance" -> Plant B.
// ─────────────────────────────────────────────────────────────
const createDepartmentForPlant = async (req, res) => {
  try {
    const { plantId } = req.params;
    const { departmentId } = req.body;
    const tenantId = resolveTenantId(req);

    if (!departmentId) {
      return res.status(400).json({
        success: false,
        message: "departmentId is required",
      });
    }
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: "tenantId is required",
      });
    }

    const { Department, TenantDepartment } = req.masterModels;
    const { Plant, TenantDepartmentPlant } = await resolveTenantModels(req, tenantId);

    // Plant must belong to this tenant
    const plant = await Plant.findOne({
      where: { id: plantId, tenantId, status: "ACTIVE" },
    });
    if (!plant) {
      return res.status(403).json({
        success: false,
        message: "Plant not found or does not belong to your tenant",
      });
    }

    // Department must exist and must already be assigned to this tenant —
    // guarantees we never create a mapping to a Department this tenant
    // isn't allowed to use.
    const tenantDepartment = await TenantDepartment.findOne({
      where: { tenantId, departmentId, status: "ACTIVE" },
      include: [{ model: Department, where: { status: "ACTIVE" } }],
    });
    if (!tenantDepartment) {
      return res.status(403).json({
        success: false,
        message: "Department is not assigned to your tenant",
      });
    }

    const [mapping, created] = await TenantDepartmentPlant.findOrCreate({
      where: { tenantId, departmentId, plantId: plant.id },
      defaults: {
        tenantDepartmentId: tenantDepartment.id,
        companyCodeId: plant.companyCodeId,
        assignedBy: req.user.id,
        status: "ACTIVE",
      },
    });

    if (!created && mapping.status !== "ACTIVE") {
      await mapping.update({ status: "ACTIVE", assignedBy: req.user.id });
    }

    return res.status(created ? 201 : 200).json({
      success: true,
      message: created
        ? "Department mapped to plant successfully"
        : "Department was already mapped to this plant",
      data: mapping,
    });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "Department is already mapped to this plant",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Shared implementation for both GET /api/departments/plant/:plantId and
// GET /api/departments?plantId=
//
// PHASE G: TenantDepartmentPlant (tenant-side) used to `include: [Department]`
// (master-side) here — that's a cross-database join Sequelize can't do
// once they're on separate physical connections. Split into two queries
// (mapping rows from the tenant DB, Department rows from the Master DB)
// and joined in JS instead.
async function getDepartmentsByPlantInternal(req, res, plantId, tenantId) {
  const tenantModels = await resolveTenantModels(req, tenantId);
  const { Plant, TenantDepartmentPlant } = tenantModels;
  const { Department } = req.masterModels;

  const plantWhere = { id: plantId, status: "ACTIVE" };
  if (tenantId) plantWhere.tenantId = tenantId;

  const plant = await Plant.findOne({ where: plantWhere });
  if (!plant) {
    return res.status(403).json({
      success: false,
      message: "Plant not found or does not belong to your tenant",
    });
  }

  const mappings = await TenantDepartmentPlant.findAll({
    where: { plantId: plant.id, status: "ACTIVE", ...(tenantId ? { tenantId } : {}) },
    raw: true,
  });

  const departmentIds = [...new Set(mappings.map((m) => m.departmentId))];
  const depts = departmentIds.length
    ? await Department.findAll({
        where: { id: { [Op.in]: departmentIds }, status: "ACTIVE" },
        attributes: ["id", "name", "code", "description"],
        order: [["name", "ASC"]],
      })
    : [];

  return res.json({ success: true, count: depts.length, data: depts });
}

// ─────────────────────────────────────────────────────────────
// GET /api/departments/plant/:plantId
// Get all active departments mapped to a specific Plant, scoped to the
// caller's own tenant (SuperAdmin may pass ?tenantId= to scope explicitly,
// or omit it to see mappings across all tenants for that plant).
// ─────────────────────────────────────────────────────────────
const getDepartmentsByPlant = async (req, res) => {
  try {
    const { plantId } = req.params;
    const tenantId = resolveTenantId(req);
    return getDepartmentsByPlantInternal(req, res, plantId, tenantId);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/departments/:departmentId/plants
// Get all of the CALLING TENANT's own Plants that this (shared, global)
// Department has been mapped to. Two different tenants calling this for
// the same departmentId will only ever see their own Plants.
// ─────────────────────────────────────────────────────────────
const getPlantsForDepartment = async (req, res) => {
  try {
    const { departmentId } = req.params;
    const tenantId = resolveTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: "tenantId is required",
      });
    }

    const { Department } = req.masterModels;
    const dept = await Department.findOne({ where: { id: departmentId, status: "ACTIVE" } });
    if (!dept) {
      return res.status(404).json({ success: false, message: "Department not found" });
    }

    const { Plant, CompanyCode, TenantDepartmentPlant } = await resolveTenantModels(req, tenantId);
    const mappings = await TenantDepartmentPlant.findAll({
      where: { departmentId, tenantId, status: "ACTIVE" },
      include: [
        { model: Plant, where: { status: "ACTIVE" }, attributes: ["id", "code", "name", "companyCodeId"] },
        { model: CompanyCode, attributes: ["id", "code", "name"] },
      ],
    });

    const plants = mappings.map((m) => m.Plant).filter(Boolean);

    return res.json({ success: true, count: plants.length, data: plants });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/departments/plant/:plantId/:departmentId
// Remove (deactivate) this tenant's own mapping of a Department to a Plant.
// Only ever affects the calling tenant's mapping row.
// ─────────────────────────────────────────────────────────────
const removeDepartmentFromPlant = async (req, res) => {
  try {
    const { plantId, departmentId } = req.params;
    const tenantId = resolveTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: "tenantId is required",
      });
    }

    const { TenantDepartmentPlant } = await resolveTenantModels(req, tenantId);
    const mapping = await TenantDepartmentPlant.findOne({
      where: { tenantId, plantId, departmentId },
    });

    if (!mapping) {
      return res.status(404).json({
        success: false,
        message: "Mapping not found for your tenant",
      });
    }

    if (mapping.status === "INACTIVE") {
      return res.status(400).json({
        success: false,
        message: "Mapping is already inactive",
      });
    }

    await mapping.update({ status: "INACTIVE" });

    return res.json({
      success: true,
      message: "Department unmapped from plant successfully",
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createDepartment,
  listDepartments,
  updateDepartment,
  assignDepartmentsToTenant,
  getTenantDepartments,
  removeDepartmentFromTenant,
  getTenantsForDepartment,
  createDepartmentForPlant,
  getDepartmentsByPlant,
  getPlantsForDepartment,
  removeDepartmentFromPlant,
};
