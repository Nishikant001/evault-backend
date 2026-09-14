// src/controllers/approvalWorkflowController.js
//
// Backs the tenant-facing "Approval Matrix Builder" — create/update/
// delete a workflow (Department -> Category -> DocumentType), configure
// its ordered levels, and assign approvers per level (by Role, User,
// Designation, or Department).
//
// PHASE G — ApprovalWorkflow/ApprovalLevel/ApprovalAssignment/
// DocumentApproval/Category/DocumentType are tenant-side (req.models).
// Department/TenantDepartment are Master DB models (req.masterModels).
// Transactions now use the tenant's OWN connection
// (req.models.ApprovalWorkflow.sequelize) instead of the legacy shared
// connection. list()'s Department include was a cross-database join —
// split into two queries, joined in JS, same as departmentController.js.
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

function levelInclude(models) {
  return [
    {
      model: models.ApprovalLevel,
      as: "levels",
      include: [{ model: models.ApprovalAssignment, as: "assignments" }],
    },
  ];
}

async function verifyCombo(models, masterModels, tenantId, departmentId, categoryId, documentTypeId) {
  const deptAssigned = await masterModels.TenantDepartment.findOne({
    where: { tenantId, departmentId, status: "ACTIVE" },
  });
  if (!deptAssigned) return "This department is not assigned to your tenant";

  const category = await models.Category.findOne({ where: { id: categoryId, tenantId, departmentId } });
  if (!category) return "Category not found under this department for your tenant";

  const documentType = await models.DocumentType.findOne({ where: { id: documentTypeId, tenantId, categoryId } });
  if (!documentType) return "Document type not found under this category for your tenant";

  return null;
}

async function replaceLevels(models, workflow, levels, transaction) {
  const { ApprovalLevel, ApprovalAssignment } = models;
  const existingLevels = await ApprovalLevel.findAll({
    where: { approvalWorkflowId: workflow.id },
    transaction,
  });
  const existingLevelIds = existingLevels.map((l) => l.id);
  if (existingLevelIds.length > 0) {
    await ApprovalAssignment.destroy({ where: { approvalLevelId: existingLevelIds }, transaction });
    await ApprovalLevel.destroy({ where: { approvalWorkflowId: workflow.id }, transaction });
  }

  for (const [idx, lvl] of levels.entries()) {
    const level = await ApprovalLevel.create(
      {
        approvalWorkflowId: workflow.id,
        levelNumber: lvl.levelNumber ?? idx + 1,
        name: lvl.name,
        isParallel: !!lvl.isParallel,
        status: lvl.status || "ACTIVE",
      },
      { transaction }
    );

    const assignments = Array.isArray(lvl.assignments) ? lvl.assignments : [];
    for (const a of assignments) {
      await ApprovalAssignment.create(
        {
          approvalLevelId: level.id,
          approverType: a.approverType,
          approverRole: a.approverRole || null,
          approverUserId: a.approverType === "USER" ? a.approverUserId : null,
          approverDepartmentId: a.approverDepartmentId || null,
          status: "ACTIVE",
        },
        { transaction }
      );
    }
  }
}

const ApprovalWorkflowController = {
  // POST /api/approval-workflows — create a workflow + its levels/assignments
  async create(req, res) {
    try {
      const { ApprovalWorkflow } = req.models;
      const tenantId = req.user.tenantId;
      const { departmentId, categoryId, documentTypeId, name, description, approvalMode, allowSelfApproval, levels } = req.body;

      if (!departmentId || !categoryId || !documentTypeId || !name) {
        return res.status(400).json({ success: false, message: "departmentId, categoryId, documentTypeId and name are required" });
      }
      if (!Array.isArray(levels) || levels.length === 0) {
        return res.status(400).json({ success: false, message: "At least one approval level is required" });
      }

      const comboError = await verifyCombo(req.models, req.masterModels, tenantId, departmentId, categoryId, documentTypeId);
      if (comboError) return res.status(403).json({ success: false, message: comboError });

      const result = await ApprovalWorkflow.sequelize.transaction(async (t) => {
        const workflow = await ApprovalWorkflow.create(
          {
            tenantId,
            departmentId,
            categoryId,
            documentTypeId,
            name,
            description,
            approvalMode: approvalMode || "SEQUENTIAL",
            allowSelfApproval: !!allowSelfApproval,
            status: "ACTIVE",
            createdBy: req.user.id,
          },
          { transaction: t }
        );
        await replaceLevels(req.models, workflow, levels, t);
        return workflow;
      });

      const full = await ApprovalWorkflow.findByPk(result.id, { include: levelInclude(req.models) });

      await AuditService.log({
        req,
        module: AUDIT_MODULES.APPROVAL,
        action: AUDIT_ACTIONS.APPROVAL_WORKFLOW_CREATED,
        newValue: { id: result.id, name, departmentId, categoryId, documentTypeId, levels: levels.length },
        remarks: `Created approval workflow "${name}"`,
        status: AUDIT_STATUS.SUCCESS,
      });

      return res.status(201).json({ success: true, data: full });
    } catch (error) {
      if (error.name === "SequelizeUniqueConstraintError") {
        return res.status(409).json({ success: false, message: "An approval workflow already exists for this Department/Category/DocumentType combination" });
      }
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  // GET /api/approval-workflows — list all workflows for the tenant
  async list(req, res) {
    try {
      const { ApprovalWorkflow, Category, DocumentType } = req.models;
      const tenantId = req.user.tenantId;
      const { departmentId, categoryId, documentTypeId, status } = req.query;

      const where = { tenantId };
      if (departmentId) where.departmentId = departmentId;
      if (categoryId) where.categoryId = categoryId;
      if (documentTypeId) where.documentTypeId = documentTypeId;
      if (status) where.status = status;

      const workflows = await ApprovalWorkflow.findAll({
        where,
        include: [
          ...levelInclude(req.models),
          { model: Category, attributes: ["id", "name"] },
          { model: DocumentType, attributes: ["id", "name"] },
        ],
        order: [["createdAt", "DESC"]],
      });

      // Department is Master DB — a cross-database include isn't possible,
      // so it's hydrated separately and merged in.
      const departmentIds = [...new Set(workflows.map((w) => w.departmentId).filter(Boolean))];
      const departments = departmentIds.length
        ? await req.masterModels.Department.findAll({ where: { id: departmentIds }, attributes: ["id", "name", "code"], raw: true })
        : [];
      const departmentById = new Map(departments.map((d) => [d.id, d]));
      const data = workflows.map((w) => {
        const json = w.toJSON();
        json.Department = w.departmentId ? departmentById.get(w.departmentId) || null : null;
        return json;
      });

      return res.json({ success: true, data, total: data.length });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  // GET /api/approval-workflows/by-combo?departmentId=&categoryId=&documentTypeId=
  // Lets the upload UI check up-front whether approval is required.
  async getByCombo(req, res) {
    try {
      const { ApprovalWorkflow } = req.models;
      const tenantId = req.user.tenantId;
      const { departmentId, categoryId, documentTypeId } = req.query;
      if (!departmentId || !categoryId || !documentTypeId) {
        return res.status(400).json({ success: false, message: "departmentId, categoryId and documentTypeId are required" });
      }

      const workflow = await ApprovalWorkflow.findOne({
        where: { tenantId, departmentId, categoryId, documentTypeId, status: "ACTIVE" },
        include: levelInclude(req.models),
      });

      return res.json({
        success: true,
        approvalRequired: !!(workflow && workflow.levels?.length > 0),
        data: workflow,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  // GET /api/approval-workflows/:id
  async getById(req, res) {
    try {
      const { ApprovalWorkflow } = req.models;
      const tenantId = req.user.tenantId;
      const workflow = await ApprovalWorkflow.findOne({
        where: { id: req.params.id, tenantId },
        include: levelInclude(req.models),
      });
      if (!workflow) return res.status(404).json({ success: false, message: "Workflow not found" });
      return res.json({ success: true, data: workflow });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  // PUT /api/approval-workflows/:id — update metadata and/or fully replace levels
  async update(req, res) {
    try {
      const { ApprovalWorkflow } = req.models;
      const tenantId = req.user.tenantId;
      const workflow = await ApprovalWorkflow.findOne({ where: { id: req.params.id, tenantId } });
      if (!workflow) return res.status(404).json({ success: false, message: "Workflow not found" });

      const { name, description, approvalMode, allowSelfApproval, status, levels } = req.body;
      const oldValue = {
        name: workflow.name,
        approvalMode: workflow.approvalMode,
        allowSelfApproval: workflow.allowSelfApproval,
        status: workflow.status,
      };

      await ApprovalWorkflow.sequelize.transaction(async (t) => {
        await workflow.update(
          {
            name: name ?? workflow.name,
            description: description ?? workflow.description,
            approvalMode: approvalMode ?? workflow.approvalMode,
            allowSelfApproval: allowSelfApproval ?? workflow.allowSelfApproval,
            status: status ?? workflow.status,
          },
          { transaction: t }
        );

        if (Array.isArray(levels)) {
          await replaceLevels(req.models, workflow, levels, t);
        }
      });

      const full = await ApprovalWorkflow.findByPk(workflow.id, { include: levelInclude(req.models) });

      await AuditService.log({
        req,
        module: AUDIT_MODULES.APPROVAL,
        action: AUDIT_ACTIONS.APPROVAL_WORKFLOW_UPDATED,
        documentId: null,
        oldValue,
        newValue: { name: workflow.name, status: workflow.status },
        remarks: `Updated approval workflow ${workflow.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      return res.json({ success: true, data: full });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  // DELETE /api/approval-workflows/:id — soft delete (INACTIVE).
  // Hard-deleting is avoided so past DocumentApproval / ApprovalHistory
  // rows (audit trail — "nothing should ever be deleted") keep their FK.
  async remove(req, res) {
    try {
      const { ApprovalWorkflow, DocumentApproval } = req.models;
      const tenantId = req.user.tenantId;
      const workflow = await ApprovalWorkflow.findOne({ where: { id: req.params.id, tenantId } });
      if (!workflow) return res.status(404).json({ success: false, message: "Workflow not found" });

      const inFlight = await DocumentApproval.count({
        where: { approvalWorkflowId: workflow.id, status: ["SUBMITTED", "PENDING_APPROVAL", "PARTIALLY_APPROVED"] },
      });
      if (inFlight > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot delete: ${inFlight} document(s) are currently in this approval workflow`,
        });
      }

      await workflow.update({ status: "INACTIVE" });

      await AuditService.log({
        req,
        module: AUDIT_MODULES.APPROVAL,
        action: AUDIT_ACTIONS.APPROVAL_WORKFLOW_DELETED,
        oldValue: { status: "ACTIVE" },
        newValue: { status: "INACTIVE" },
        remarks: `Deactivated approval workflow ${workflow.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      return res.json({ success: true, message: "Workflow deactivated" });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  // POST /api/approval-workflows/levels/:levelId/assignments — replace approvers for one level
  async assignApprovers(req, res) {
    try {
      const { ApprovalLevel, ApprovalAssignment, ApprovalWorkflow } = req.models;
      const { levelId } = req.params;
      const { assignments } = req.body;
      if (!Array.isArray(assignments)) {
        return res.status(400).json({ success: false, message: "assignments must be an array" });
      }

      const level = await ApprovalLevel.findByPk(levelId, { include: [{ model: ApprovalWorkflow }] });
      if (!level || level.ApprovalWorkflow?.tenantId !== req.user.tenantId) {
        return res.status(404).json({ success: false, message: "Approval level not found" });
      }

      await ApprovalLevel.sequelize.transaction(async (t) => {
        await ApprovalAssignment.destroy({ where: { approvalLevelId: levelId }, transaction: t });
        for (const a of assignments) {
          await ApprovalAssignment.create(
            {
              approvalLevelId: levelId,
              approverType: a.approverType,
              approverRole: a.approverRole || null,
              approverUserId: a.approverType === "USER" ? a.approverUserId : null,
              approverDepartmentId: a.approverDepartmentId || null,
              status: "ACTIVE",
            },
            { transaction: t }
          );
        }
      });

      const updated = await ApprovalLevel.findByPk(levelId, { include: [{ model: ApprovalAssignment, as: "assignments" }] });

      await AuditService.log({
        req,
        module: AUDIT_MODULES.APPROVAL,
        action: AUDIT_ACTIONS.APPROVAL_APPROVERS_ASSIGNED,
        newValue: { levelId, assignments },
        remarks: `Assigned ${assignments.length} approver(s) to level ${levelId}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      return res.json({ success: true, data: updated });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },
};

module.exports = ApprovalWorkflowController;
