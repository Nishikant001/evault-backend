// src/services/approvalEngineService.js
//
// The reusable Approval Engine. It never hardcodes a department, category,
// document type, or approval chain — everything is resolved at runtime
// from ApprovalWorkflow / ApprovalLevel / ApprovalAssignment rows that a
// Tenant Admin configures. If no ACTIVE workflow exists for a document's
// (departmentId, categoryId, documentTypeId) combination, the engine is a
// complete no-op and the existing upload -> SAP flow is untouched.
//
// PHASE G FIX — this file used to import models from the LEGACY shared
// database (`require("../config/database")` + `require("../models")`).
// Since Phase G, every tenant lives in its OWN physical database, and
// ApprovalWorkflow/DocumentApproval/etc rows are created via req.models
// (see approvalWorkflowController.js, documentController.js). Querying
// the legacy DB here meant this engine could NEVER see a workflow a
// Tenant Admin actually created — it silently always returned
// { required: false }, so documents finalized to SAP with no approval
// gate at all. Every method below now takes `models` (== req.models,
// the caller's tenant connection) instead of using a module-level import.
const AuditService = require("./auditService");
const NotificationHookService = require("./notificationHookService");
const { finalizeDocumentToSap } = require("./sapFinalizationService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const {
  DOCUMENT_APPROVAL_STATUS: STATUS,
  APPROVAL_ACTIONS: ACTION,
  APPROVAL_EVENTS: EVENT,
} = require("../constants/approvalConstants");

const IN_PROGRESS_STATUSES = [
  STATUS.SUBMITTED,
  STATUS.PENDING_APPROVAL,
  STATUS.PARTIALLY_APPROVED,
];

function workflowInclude(models) {
  return [
    {
      model: models.ApprovalLevel,
      as: "levels",
      where: { status: "ACTIVE" },
      required: false,
      include: [{ model: models.ApprovalAssignment, as: "assignments", where: { status: "ACTIVE" }, required: false }],
    },
  ];
}

class ApprovalEngineService {
  /**
   * Finds the ACTIVE workflow (if any) configured for this document's
   * exact Department -> Category -> DocumentType combination.
   */
  static async getWorkflowForDocument(models, document) {
    const { ApprovalWorkflow, ApprovalLevel } = models;
    const workflow = await ApprovalWorkflow.findOne({
      where: {
        tenantId: document.tenantId,
        departmentId: document.departmentId,
        categoryId: document.categoryId,
        documentTypeId: document.documentTypeId,
        status: "ACTIVE",
      },
      include: workflowInclude(models),
      order: [[{ model: ApprovalLevel, as: "levels" }, "levelNumber", "ASC"]],
    });
    return workflow;
  }

  static async isApprovalRequired(models, document) {
    const workflow = await ApprovalEngineService.getWorkflowForDocument(models, document);
    return !!(workflow && workflow.levels && workflow.levels.length > 0);
  }

  /**
   * Kicks off the approval chain for a document that has just finished
   * OCR/metadata + TCode generation. No-op (returns { required: false })
   * when the tenant hasn't configured approval for this combo.
   */
  static async initiate({ document, user, req }) {
    const models = req.models;
    const { DocumentApproval, ApprovalHistory } = models;

    const workflow = await ApprovalEngineService.getWorkflowForDocument(models, document);
    const levels = (workflow?.levels || []).slice().sort((a, b) => a.levelNumber - b.levelNumber);

    if (!workflow || levels.length === 0) {
      return { required: false, documentApproval: null };
    }

    const existing = await DocumentApproval.findOne({ where: { documentId: document.id } });
    if (existing) {
      // Already has an approval run (e.g. re-submission handled via resubmit()).
      return { required: true, documentApproval: existing };
    }

    const result = await DocumentApproval.sequelize.transaction(async (t) => {
      const documentApproval = await DocumentApproval.create(
        {
          documentId: document.id,
          approvalWorkflowId: workflow.id,
          tenantId: document.tenantId,
          currentLevel: 1,
          totalLevels: levels.length,
          status: STATUS.PENDING_APPROVAL,
          submittedBy: user.id,
          submittedAt: new Date(),
        },
        { transaction: t }
      );

      await ApprovalHistory.create(
        {
          documentApprovalId: documentApproval.id,
          documentId: document.id,
          levelNumber: 1,
          action: ACTION.SUBMIT,
          actionBy: user.id,
          actionByName: user.name || user.email,
          actionByRole: user.role,
          oldStatus: null,
          newStatus: STATUS.PENDING_APPROVAL,
          comments: "Document submitted for approval",
          ipAddress: req?.ip,
        },
        { transaction: t }
      );

      return documentApproval;
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.APPROVAL,
      action: AUDIT_ACTIONS.APPROVAL_SUBMITTED,
      documentId: document.id,
      newValue: { workflowId: workflow.id, totalLevels: levels.length },
      remarks: `Approval workflow "${workflow.name}" initiated for document ${document.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    await NotificationHookService.fire(EVENT.SUBMITTED, {
      documentId: document.id,
      documentApprovalId: result.id,
      tenantId: document.tenantId,
      levelNumber: 1,
    });
    await NotificationHookService.fire(EVENT.PENDING_APPROVAL, {
      documentId: document.id,
      documentApprovalId: result.id,
      tenantId: document.tenantId,
      levelNumber: 1,
    });

    return { required: true, documentApproval: result };
  }

  /**
   * Checks whether `user` is eligible to act at the given level, honoring
   * the "uploader cannot approve own document unless explicitly
   * configured" security rule.
   */
  static userCanActOnLevel(user, level, workflow, uploaderId) {
    if (!level) return false;

    if (
      String(user.id) === String(uploaderId) &&
      !workflow.allowSelfApproval
    ) {
      return false;
    }

    const assignments = level.assignments || [];
    if (assignments.length === 0) return false;

    return assignments.some((a) => {
      if (a.status !== "ACTIVE") return false;
      switch (a.approverType) {
        case "USER":
          return String(a.approverUserId) === String(user.id);
        case "ROLE":
        case "DESIGNATION":
          return a.approverRole && a.approverRole === user.role;
        case "DEPARTMENT":
          // Users are not mapped 1:1 to a Department in this schema today,
          // so DEPARTMENT-type assignments are resolved by role match,
          // with approverDepartmentId retained for reporting/context only.
          return a.approverRole && a.approverRole === user.role;
        default:
          return false;
      }
    });
  }

  static async _loadForAction(models, documentApprovalId) {
    const { DocumentApproval, ApprovalWorkflow, ApprovalLevel, ApprovalAssignment, Document } = models;
    const documentApproval = await DocumentApproval.findByPk(documentApprovalId, {
      include: [
        {
          model: ApprovalWorkflow,
          include: [
            {
              model: ApprovalLevel,
              as: "levels",
              where: { status: "ACTIVE" },
              required: false,
              include: [{ model: ApprovalAssignment, as: "assignments", where: { status: "ACTIVE" }, required: false }],
            },
          ],
        },
        { model: Document },
      ],
    });
    return documentApproval;
  }

  static _currentLevelOf(documentApproval) {
    const levels = documentApproval.ApprovalWorkflow?.levels || [];
    return levels.find((l) => l.levelNumber === documentApproval.currentLevel);
  }

  /**
   * APPROVE the current level. If this was the FINAL level, the document
   * is pushed to SAP immediately afterward — never before.
   */
  static async approve({ documentApprovalId, user, comments, req }) {
    const models = req.models;
    const { ApprovalHistory } = models;
    const documentApproval = await ApprovalEngineService._loadForAction(models, documentApprovalId);
    if (!documentApproval) {
      const err = new Error("Approval record not found");
      err.statusCode = 404;
      throw err;
    }
    if (!IN_PROGRESS_STATUSES.includes(documentApproval.status)) {
      const err = new Error(`Document is not pending approval (current status: ${documentApproval.status})`);
      err.statusCode = 409;
      throw err;
    }

    const workflow = documentApproval.ApprovalWorkflow;
    const level = ApprovalEngineService._currentLevelOf(documentApproval);
    if (!level) {
      const err = new Error("Approval level configuration is missing or inactive");
      err.statusCode = 500;
      throw err;
    }

    if (!ApprovalEngineService.userCanActOnLevel(user, level, workflow, documentApproval.Document.uploadedBy)) {
      const err = new Error("You are not authorized to approve at the current level");
      err.statusCode = 403;
      throw err;
    }

    const oldStatus = documentApproval.status;
    const isFinalLevel = documentApproval.currentLevel >= documentApproval.totalLevels;
    const newStatus = isFinalLevel ? STATUS.APPROVED : STATUS.PARTIALLY_APPROVED;

    await documentApproval.sequelize.transaction(async (t) => {
      await documentApproval.update(
        {
          status: newStatus,
          currentLevel: isFinalLevel ? documentApproval.currentLevel : documentApproval.currentLevel + 1,
        },
        { transaction: t }
      );

      await ApprovalHistory.create(
        {
          documentApprovalId: documentApproval.id,
          documentId: documentApproval.documentId,
          levelNumber: level.levelNumber,
          action: ACTION.APPROVE,
          actionBy: user.id,
          actionByName: user.name || user.email,
          actionByRole: user.role,
          oldStatus,
          newStatus,
          comments: comments || null,
          ipAddress: req?.ip,
        },
        { transaction: t }
      );
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.APPROVAL,
      action: AUDIT_ACTIONS.APPROVAL_APPROVED,
      documentId: documentApproval.documentId,
      oldValue: { status: oldStatus, level: level.levelNumber },
      newValue: { status: newStatus },
      remarks: `Level ${level.levelNumber} (${level.name}) approved for document ${documentApproval.documentId}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    await NotificationHookService.fire(EVENT.APPROVED, {
      documentId: documentApproval.documentId,
      documentApprovalId: documentApproval.id,
      levelNumber: level.levelNumber,
      isFinalLevel,
    });

    let sapResult = null;
    if (isFinalLevel) {
      // SAP Upload happens ONLY after final approval — never before.
      sapResult = await finalizeDocumentToSap(documentApproval.Document, req);
      await documentApproval.update({ status: STATUS.COMPLETED, completedAt: new Date() });
      await NotificationHookService.fire(EVENT.COMPLETED, {
        documentId: documentApproval.documentId,
        documentApprovalId: documentApproval.id,
        sapDocumentId: sapResult.sapDocumentId,
      });
    }

    return { documentApproval, isFinalLevel, sapResult };
  }

  static async reject({ documentApprovalId, user, reason, req }) {
    const models = req.models;
    const { ApprovalHistory } = models;
    const documentApproval = await ApprovalEngineService._loadForAction(models, documentApprovalId);
    if (!documentApproval) {
      const err = new Error("Approval record not found");
      err.statusCode = 404;
      throw err;
    }
    if (!IN_PROGRESS_STATUSES.includes(documentApproval.status)) {
      const err = new Error(`Document is not pending approval (current status: ${documentApproval.status})`);
      err.statusCode = 409;
      throw err;
    }

    const workflow = documentApproval.ApprovalWorkflow;
    const level = ApprovalEngineService._currentLevelOf(documentApproval);

    if (!ApprovalEngineService.userCanActOnLevel(user, level, workflow, documentApproval.Document.uploadedBy)) {
      const err = new Error("You are not authorized to reject at the current level");
      err.statusCode = 403;
      throw err;
    }
    if (!reason || !reason.trim()) {
      const err = new Error("rejectReason is required");
      err.statusCode = 400;
      throw err;
    }

    const oldStatus = documentApproval.status;

    await documentApproval.sequelize.transaction(async (t) => {
      await documentApproval.update(
        {
          status: STATUS.REJECTED,
          rejectedBy: user.id,
          rejectedAt: new Date(),
          rejectReason: reason,
        },
        { transaction: t }
      );
      await documentApproval.Document.update({ uploadStatus: "REJECTED" }, { transaction: t });

      await ApprovalHistory.create(
        {
          documentApprovalId: documentApproval.id,
          documentId: documentApproval.documentId,
          levelNumber: level?.levelNumber ?? documentApproval.currentLevel,
          action: ACTION.REJECT,
          actionBy: user.id,
          actionByName: user.name || user.email,
          actionByRole: user.role,
          oldStatus,
          newStatus: STATUS.REJECTED,
          rejectReason: reason,
          ipAddress: req?.ip,
        },
        { transaction: t }
      );
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.APPROVAL,
      action: AUDIT_ACTIONS.APPROVAL_REJECTED,
      documentId: documentApproval.documentId,
      oldValue: { status: oldStatus },
      newValue: { status: STATUS.REJECTED, reason },
      remarks: `Document ${documentApproval.documentId} rejected at level ${level?.levelNumber}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    await NotificationHookService.fire(EVENT.REJECTED, {
      documentId: documentApproval.documentId,
      documentApprovalId: documentApproval.id,
      reason,
    });

    return documentApproval;
  }

  static async sendBack({ documentApprovalId, user, comments, req }) {
    const models = req.models;
    const { ApprovalHistory } = models;
    const documentApproval = await ApprovalEngineService._loadForAction(models, documentApprovalId);
    if (!documentApproval) {
      const err = new Error("Approval record not found");
      err.statusCode = 404;
      throw err;
    }
    if (!IN_PROGRESS_STATUSES.includes(documentApproval.status)) {
      const err = new Error(`Document is not pending approval (current status: ${documentApproval.status})`);
      err.statusCode = 409;
      throw err;
    }

    const workflow = documentApproval.ApprovalWorkflow;
    const level = ApprovalEngineService._currentLevelOf(documentApproval);

    if (!ApprovalEngineService.userCanActOnLevel(user, level, workflow, documentApproval.Document.uploadedBy)) {
      const err = new Error("You are not authorized to send back at the current level");
      err.statusCode = 403;
      throw err;
    }

    const oldStatus = documentApproval.status;

    await documentApproval.sequelize.transaction(async (t) => {
      await documentApproval.update({ status: STATUS.SENT_BACK, currentLevel: 1 }, { transaction: t });

      await ApprovalHistory.create(
        {
          documentApprovalId: documentApproval.id,
          documentId: documentApproval.documentId,
          levelNumber: level.levelNumber,
          action: ACTION.SEND_BACK,
          actionBy: user.id,
          actionByName: user.name || user.email,
          actionByRole: user.role,
          oldStatus,
          newStatus: STATUS.SENT_BACK,
          comments: comments || null,
          ipAddress: req?.ip,
        },
        { transaction: t }
      );
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.APPROVAL,
      action: AUDIT_ACTIONS.APPROVAL_SENT_BACK,
      documentId: documentApproval.documentId,
      oldValue: { status: oldStatus },
      newValue: { status: STATUS.SENT_BACK },
      remarks: `Document ${documentApproval.documentId} sent back for correction by level ${level.levelNumber}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    await NotificationHookService.fire(EVENT.SENT_BACK, {
      documentId: documentApproval.documentId,
      documentApprovalId: documentApproval.id,
    });

    return documentApproval;
  }

  static async cancel({ documentApprovalId, user, reason, req }) {
    const models = req.models;
    const { ApprovalHistory } = models;
    const documentApproval = await ApprovalEngineService._loadForAction(models, documentApprovalId);
    if (!documentApproval) {
      const err = new Error("Approval record not found");
      err.statusCode = 404;
      throw err;
    }
    if ([STATUS.COMPLETED, STATUS.CANCELLED].includes(documentApproval.status)) {
      const err = new Error(`Cannot cancel a document in status ${documentApproval.status}`);
      err.statusCode = 409;
      throw err;
    }

    const isOwner = String(documentApproval.submittedBy) === String(user.id);
    const isAdmin = ["SuperAdmin", "TenantAdmin"].includes(user.role);
    if (!isOwner && !isAdmin) {
      const err = new Error("Only the submitter or a Tenant Admin can cancel this approval");
      err.statusCode = 403;
      throw err;
    }

    const oldStatus = documentApproval.status;

    await documentApproval.sequelize.transaction(async (t) => {
      await documentApproval.update({ status: STATUS.CANCELLED }, { transaction: t });

      await ApprovalHistory.create(
        {
          documentApprovalId: documentApproval.id,
          documentId: documentApproval.documentId,
          levelNumber: documentApproval.currentLevel,
          action: ACTION.CANCEL,
          actionBy: user.id,
          actionByName: user.name || user.email,
          actionByRole: user.role,
          oldStatus,
          newStatus: STATUS.CANCELLED,
          comments: reason || null,
          ipAddress: req?.ip,
        },
        { transaction: t }
      );
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.APPROVAL,
      action: AUDIT_ACTIONS.APPROVAL_CANCELLED,
      documentId: documentApproval.documentId,
      oldValue: { status: oldStatus },
      newValue: { status: STATUS.CANCELLED },
      remarks: `Approval workflow cancelled for document ${documentApproval.documentId}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    await NotificationHookService.fire(EVENT.CANCELLED, {
      documentId: documentApproval.documentId,
      documentApprovalId: documentApproval.id,
    });

    return documentApproval;
  }

  static async resubmit({ documentApprovalId, user, req }) {
    const models = req.models;
    const { ApprovalHistory } = models;
    const documentApproval = await ApprovalEngineService._loadForAction(models, documentApprovalId);
    if (!documentApproval) {
      const err = new Error("Approval record not found");
      err.statusCode = 404;
      throw err;
    }
    if (![STATUS.SENT_BACK, STATUS.REJECTED].includes(documentApproval.status)) {
      const err = new Error(`Only a SENT_BACK or REJECTED document can be resubmitted (current: ${documentApproval.status})`);
      err.statusCode = 409;
      throw err;
    }

    const isOwner = String(documentApproval.submittedBy) === String(user.id);
    const isAdmin = ["SuperAdmin", "TenantAdmin"].includes(user.role);
    if (!isOwner && !isAdmin) {
      const err = new Error("Only the original submitter or a Tenant Admin can resubmit");
      err.statusCode = 403;
      throw err;
    }

    const oldStatus = documentApproval.status;

    await documentApproval.sequelize.transaction(async (t) => {
      await documentApproval.update(
        {
          status: STATUS.PENDING_APPROVAL,
          currentLevel: 1,
          submittedAt: new Date(),
          rejectedBy: null,
          rejectedAt: null,
          rejectReason: null,
        },
        { transaction: t }
      );
      await documentApproval.Document.update({ uploadStatus: "WAITING_FOR_APPROVAL" }, { transaction: t });

      await ApprovalHistory.create(
        {
          documentApprovalId: documentApproval.id,
          documentId: documentApproval.documentId,
          levelNumber: 1,
          action: ACTION.RESUBMIT,
          actionBy: user.id,
          actionByName: user.name || user.email,
          actionByRole: user.role,
          oldStatus,
          newStatus: STATUS.PENDING_APPROVAL,
          ipAddress: req?.ip,
        },
        { transaction: t }
      );
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.APPROVAL,
      action: AUDIT_ACTIONS.APPROVAL_RESUBMITTED,
      documentId: documentApproval.documentId,
      oldValue: { status: oldStatus },
      newValue: { status: STATUS.PENDING_APPROVAL },
      remarks: `Document ${documentApproval.documentId} resubmitted for approval`,
      status: AUDIT_STATUS.SUCCESS,
    });

    await NotificationHookService.fire(EVENT.SUBMITTED, {
      documentId: documentApproval.documentId,
      documentApprovalId: documentApproval.id,
      levelNumber: 1,
    });

    return documentApproval;
  }

  static async addComment({ documentApprovalId, user, comment, levelNumber, req }) {
    const { DocumentApproval, ApprovalComment } = req.models;
    const documentApproval = await DocumentApproval.findByPk(documentApprovalId);
    if (!documentApproval) {
      const err = new Error("Approval record not found");
      err.statusCode = 404;
      throw err;
    }
    return ApprovalComment.create({
      documentApprovalId,
      levelNumber: levelNumber ?? documentApproval.currentLevel,
      userId: user.id,
      comment,
    });
  }

  /**
   * Documents currently awaiting action from `user` — i.e. `user` is
   * eligible to act on the CURRENT level of an in-progress approval.
   */
  static async getPendingForUser(req) {
    const models = req.models;
    const { DocumentApproval, ApprovalWorkflow, ApprovalLevel, ApprovalAssignment, Document } = models;
    const user = req.user;
    const candidates = await DocumentApproval.findAll({
      where: { tenantId: user.tenantId, status: [STATUS.PENDING_APPROVAL, STATUS.PARTIALLY_APPROVED] },
      include: [
        {
          model: ApprovalWorkflow,
          include: [
            {
              model: ApprovalLevel,
              as: "levels",
              where: { status: "ACTIVE" },
              required: false,
              include: [{ model: ApprovalAssignment, as: "assignments", where: { status: "ACTIVE" }, required: false }],
            },
          ],
        },
        { model: Document },
      ],
      order: [["createdAt", "DESC"]],
    });

    return candidates.filter((da) => {
      const level = ApprovalEngineService._currentLevelOf(da);
      const canAct = ApprovalEngineService.userCanActOnLevel(user, level, da.ApprovalWorkflow, da.Document?.uploadedBy);
      console.log("[APPROVAL DEBUG]", {
        documentApprovalId: da.id,
        documentApprovalTenantId: da.tenantId,
        userTenantId: user.tenantId,
        userId: user.id,
        userRole: user.role,
        uploadedBy: da.Document?.uploadedBy,
        levelFound: !!level,
        levelAssignments: level?.assignments?.map(a => ({ type: a.approverType, role: a.approverRole, userId: a.approverUserId, status: a.status })),
        canAct,
      });
      return canAct;
    });
  }

  static async getMyApprovalActions(req) {
    const { ApprovalHistory } = req.models;
    return ApprovalHistory.findAll({
      where: { actionBy: req.user.id },
      order: [["createdAt", "DESC"]],
    });
  }

  static async getTimeline(req, documentApprovalId) {
    const { ApprovalHistory } = req.models;
    return ApprovalHistory.findAll({
      where: { documentApprovalId },
      order: [["createdAt", "ASC"]],
    });
  }

  static async getDetails(req, documentApprovalId) {
    const { DocumentApproval, ApprovalWorkflow, ApprovalLevel, ApprovalAssignment, Document, ApprovalHistory, ApprovalComment, User } = req.models;
    return DocumentApproval.findByPk(documentApprovalId, {
      include: [
        {
          model: ApprovalWorkflow,
          include: [
            {
              model: ApprovalLevel,
              as: "levels",
              include: [{ model: ApprovalAssignment, as: "assignments" }],
            },
          ],
        },
        { model: Document },
        { model: ApprovalHistory, as: "history", separate: true, order: [["createdAt", "ASC"]] },
        { model: ApprovalComment, as: "comments", separate: true, order: [["createdAt", "ASC"]] },
        { model: User, as: "submitter", attributes: ["id", "name", "email"] },
      ],
    });
  }
}

module.exports = ApprovalEngineService;