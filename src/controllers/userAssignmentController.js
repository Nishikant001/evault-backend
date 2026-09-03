// src/controllers/userAssignmentController.js
//
// TenantAdmin-facing CRUD for the Dynamic User Assignment Engine.
// Follows the same clean-controller / AuditService pattern already used
// by categoryController.js and documentTypeController.js.
//
// PHASE G — UserAssignment/User/Category/DocumentType are tenant-side
// models (req.models); Department is a Master DB model (req.masterModels)
// — see PHASE_F_MIGRATION_REPORT.md section 1. Helper functions below now
// take the relevant model set explicitly instead of a static top-level
// legacy import.
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const { ASSIGNMENT_LEVELS, ASSIGNMENT_STATUS } = require("../constants/assignmentConstants");

// ── Helper: make sure the target user belongs to this tenant ────
async function verifyUserInTenant(models, tenantId, userId) {
  return models.User.findOne({ where: { id: userId, tenantId } });
}

// ── Helper: validate the target (department/category/documentType)
//    exists, is ACTIVE, and belongs to this tenant. Returns the
//    resolved { departmentId, categoryId, documentTypeId } triple so the
//    UserAssignment row always carries a consistent department/category
//    context, no matter which level was assigned. ─────────────────
async function resolveTarget(models, masterModels, tenantId, level, { departmentId, categoryId, documentTypeId }) {
  if (level === ASSIGNMENT_LEVELS.DEPARTMENT) {
    if (!departmentId) throw new Error("departmentId is required for DEPARTMENT level");
    const dept = await masterModels.Department.findOne({ where: { id: departmentId, status: "ACTIVE" } });
    if (!dept) throw new Error("Department not found");
    return { departmentId: dept.id, categoryId: null, documentTypeId: null };
  }

  if (level === ASSIGNMENT_LEVELS.CATEGORY) {
    if (!categoryId) throw new Error("categoryId is required for CATEGORY level");
    const category = await models.Category.findOne({ where: { id: categoryId, tenantId, status: "ACTIVE" } });
    if (!category) throw new Error("Category not found or does not belong to your tenant");
    return { departmentId: category.departmentId, categoryId: category.id, documentTypeId: null };
  }

  if (level === ASSIGNMENT_LEVELS.DOCUMENT_TYPE) {
    if (!documentTypeId) throw new Error("documentTypeId is required for DOCUMENT_TYPE level");
    const docType = await models.DocumentType.findOne({
      where: { id: documentTypeId, tenantId, status: "ACTIVE" },
      include: [{ model: models.Category }],
    });
    if (!docType) throw new Error("Document type not found or does not belong to your tenant");
    return {
      departmentId: docType.Category ? docType.Category.departmentId : null,
      categoryId: docType.categoryId,
      documentTypeId: docType.id,
    };
  }

  throw new Error("Invalid assignmentLevel. Must be DEPARTMENT, CATEGORY or DOCUMENT_TYPE");
}

// ── Create (assign) ────────────────────────────────────────────
const createAssignment = async (req, res) => {
  try {
    const { UserAssignment } = req.models;
    const tenantId = req.user.tenantId;
    const assignedBy = req.user.id;
    const { userId, assignmentLevel, departmentId, categoryId, documentTypeId } = req.body;

    if (!userId || !assignmentLevel) {
      return res.status(400).json({
        success: false,
        message: "userId and assignmentLevel are required",
      });
    }

    if (!Object.values(ASSIGNMENT_LEVELS).includes(assignmentLevel)) {
      return res.status(400).json({
        success: false,
        message: "assignmentLevel must be one of DEPARTMENT, CATEGORY, DOCUMENT_TYPE",
      });
    }

    const targetUser = await verifyUserInTenant(req.models, tenantId, userId);
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        message: "User not found in your tenant",
      });
    }

    let target;
    try {
      target = await resolveTarget(req.models, req.masterModels, tenantId, assignmentLevel, {
        departmentId,
        categoryId,
        documentTypeId,
      });
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    const assignment = await UserAssignment.create({
      tenantId,
      userId,
      assignmentLevel,
      departmentId: target.departmentId,
      categoryId: target.categoryId,
      documentTypeId: target.documentTypeId,
      assignedBy,
      status: ASSIGNMENT_STATUS.ACTIVE,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.USER_ASSIGNMENT,
      action: AUDIT_ACTIONS.USER_ASSIGNMENT_CREATED,
      newValue: assignment.toJSON(),
      remarks: `Assigned user #${userId} to ${assignmentLevel} scope`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({ success: true, data: assignment });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "This exact assignment already exists for this user",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── List assignments (optionally filter by userId) ────────────
const listAssignments = async (req, res) => {
  try {
    const { UserAssignment, User, Category, DocumentType } = req.models;
    const tenantId = req.user.tenantId;
    const { userId, status } = req.query;

    const where = { tenantId };
    if (userId) where.userId = userId;
    where.status = status || ASSIGNMENT_STATUS.ACTIVE;

    const assignments = await UserAssignment.findAll({
      where,
      include: [
        { model: User, as: "assignedUser", attributes: ["id", "name", "email", "role"] },
        { model: User, as: "assignor", attributes: ["id", "name", "email"] },
        { model: Category, attributes: ["id", "name"] },
        { model: DocumentType, attributes: ["id", "name"] },
      ],
      order: [["createdAt", "DESC"]],
    });

    // Department is Master DB — hydrated separately and merged in, rather
    // than a cross-database `include` (which Sequelize cannot do; the two
    // models don't even share a connection).
    const departmentIds = [...new Set(assignments.map((a) => a.departmentId).filter(Boolean))];
    const departments = departmentIds.length
      ? await req.masterModels.Department.findAll({ where: { id: departmentIds }, attributes: ["id", "name", "code"], raw: true })
      : [];
    const departmentById = new Map(departments.map((d) => [d.id, d]));
    const data = assignments.map((a) => {
      const json = a.toJSON();
      json.Department = a.departmentId ? departmentById.get(a.departmentId) || null : null;
      return json;
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Get a single user's full assignment set ────────────────────
const getUserAssignments = async (req, res) => {
  try {
    const { UserAssignment, Category, DocumentType } = req.models;
    const tenantId = req.user.tenantId;
    const { userId } = req.params;

    const targetUser = await verifyUserInTenant(req.models, tenantId, userId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: "User not found in your tenant" });
    }

    const assignments = await UserAssignment.findAll({
      where: { tenantId, userId, status: ASSIGNMENT_STATUS.ACTIVE },
      include: [
        { model: Category, attributes: ["id", "name"] },
        { model: DocumentType, attributes: ["id", "name"] },
      ],
      order: [["createdAt", "DESC"]],
    });

    const departmentIds = [...new Set(assignments.map((a) => a.departmentId).filter(Boolean))];
    const departments = departmentIds.length
      ? await req.masterModels.Department.findAll({ where: { id: departmentIds }, attributes: ["id", "name", "code"], raw: true })
      : [];
    const departmentById = new Map(departments.map((d) => [d.id, d]));
    const data = assignments.map((a) => {
      const json = a.toJSON();
      json.Department = a.departmentId ? departmentById.get(a.departmentId) || null : null;
      return json;
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Update an assignment (change its target) ────────────────────
const updateAssignment = async (req, res) => {
  try {
    const { UserAssignment } = req.models;
    const tenantId = req.user.tenantId;
    const { id } = req.params;
    const { assignmentLevel, departmentId, categoryId, documentTypeId } = req.body;

    const assignment = await UserAssignment.findOne({ where: { id, tenantId } });
    if (!assignment) {
      return res.status(404).json({ success: false, message: "Assignment not found" });
    }

    const oldValue = assignment.toJSON();
    const level = assignmentLevel || assignment.assignmentLevel;

    if (!Object.values(ASSIGNMENT_LEVELS).includes(level)) {
      return res.status(400).json({
        success: false,
        message: "assignmentLevel must be one of DEPARTMENT, CATEGORY, DOCUMENT_TYPE",
      });
    }

    let target;
    try {
      target = await resolveTarget(req.models, req.masterModels, tenantId, level, {
        departmentId: departmentId ?? assignment.departmentId,
        categoryId: categoryId ?? assignment.categoryId,
        documentTypeId: documentTypeId ?? assignment.documentTypeId,
      });
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    await assignment.update({
      assignmentLevel: level,
      departmentId: target.departmentId,
      categoryId: target.categoryId,
      documentTypeId: target.documentTypeId,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.USER_ASSIGNMENT,
      action: AUDIT_ACTIONS.USER_ASSIGNMENT_UPDATED,
      oldValue,
      newValue: assignment.toJSON(),
      remarks: `Updated assignment #${assignment.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: assignment });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "This exact assignment already exists for this user",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Revoke (soft delete) an assignment ──────────────────────────
const revokeAssignment = async (req, res) => {
  try {
    const { UserAssignment } = req.models;
    const tenantId = req.user.tenantId;
    const { id } = req.params;

    const assignment = await UserAssignment.findOne({ where: { id, tenantId } });
    if (!assignment) {
      return res.status(404).json({ success: false, message: "Assignment not found" });
    }

    await assignment.update({ status: ASSIGNMENT_STATUS.INACTIVE });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.USER_ASSIGNMENT,
      action: AUDIT_ACTIONS.USER_ASSIGNMENT_REVOKED,
      oldValue: { status: ASSIGNMENT_STATUS.ACTIVE },
      newValue: { status: ASSIGNMENT_STATUS.INACTIVE },
      remarks: `Revoked assignment #${assignment.id} for user #${assignment.userId}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, message: "Assignment revoked" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createAssignment,
  listAssignments,
  getUserAssignments,
  updateAssignment,
  revokeAssignment,
};
