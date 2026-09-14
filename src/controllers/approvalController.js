// src/controllers/approvalController.js
//
// Runtime approval actions against a specific document's approval run.
// All business logic lives in approvalEngineService — this controller
// only validates input, forwards to the engine, and shapes the response.
//
// PHASE G: this controller's OWN direct model access (submit/getByDocument)
// now reads from req.models (tenant-side, set by tenantResolverMiddleware).
// approvalEngineService.js itself still resolves models internally — see
// PHASE_G_LEGACY_REMOVAL_REPORT.md "Remaining risk" for its conversion
// status; not changed in this pass.
const ApprovalEngineService = require("../services/approvalEngineService");

function handleEngineError(res, error) {
  console.error("[Approval Engine Error]", error);
  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({ success: false, message: error.message });
}

const ApprovalController = {
  // POST /api/approvals/documents/:documentId/submit
  // Normally invoked automatically right after TCode generation
  // (see documentController.generateTcode); exposed standalone too, in
  // case a document needs to be (re-)entered into its workflow.
  async submit(req, res) {
    try {
      const { Document } = req.models;
      const document = await Document.findOne({
        where: { id: req.params.documentId, tenantId: req.user.tenantId, status: "ACTIVE" },
      });
      if (!document) return res.status(404).json({ success: false, message: "Document not found" });

      const result = await ApprovalEngineService.initiate({ document, user: req.user, req });
      return res.status(201).json({ success: true, ...result });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // POST /api/approvals/:id/approve
  async approve(req, res) {
    try {
      const { comments } = req.body;
      const result = await ApprovalEngineService.approve({
        documentApprovalId: req.params.id,
        user: req.user,
        comments,
        req,
      });
      return res.json({
        success: true,
                message: result.isFinalLevel
          ? result.sapResult?.usedSap
            ? "Final approval granted — document sent to SAP"
            : "Final approval granted — document finalized"
          : "Approved, moved to next level",
        data: result.documentApproval,
        sap: result.sapResult,
      });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // POST /api/approvals/:id/reject
  async reject(req, res) {
    try {
      const { reason } = req.body;
      const documentApproval = await ApprovalEngineService.reject({
        documentApprovalId: req.params.id,
        user: req.user,
        reason,
        req,
      });
      return res.json({ success: true, message: "Document rejected", data: documentApproval });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // POST /api/approvals/:id/send-back
  async sendBack(req, res) {
    try {
      const { comments } = req.body;
      const documentApproval = await ApprovalEngineService.sendBack({
        documentApprovalId: req.params.id,
        user: req.user,
        comments,
        req,
      });
      return res.json({ success: true, message: "Sent back for correction", data: documentApproval });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // POST /api/approvals/:id/cancel
  async cancel(req, res) {
    try {
      const { reason } = req.body;
      const documentApproval = await ApprovalEngineService.cancel({
        documentApprovalId: req.params.id,
        user: req.user,
        reason,
        req,
      });
      return res.json({ success: true, message: "Approval workflow cancelled", data: documentApproval });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // POST /api/approvals/:id/resubmit
  async resubmit(req, res) {
    try {
      const documentApproval = await ApprovalEngineService.resubmit({
        documentApprovalId: req.params.id,
        user: req.user,
        req,
      });
      return res.json({ success: true, message: "Resubmitted for approval", data: documentApproval });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // POST /api/approvals/:id/comments
  async addComment(req, res) {
    try {
      const { comment, levelNumber } = req.body;
      if (!comment || !comment.trim()) {
        return res.status(400).json({ success: false, message: "comment is required" });
      }
      const created = await ApprovalEngineService.addComment({
        documentApprovalId: req.params.id,
        user: req.user,
        comment,
        levelNumber,
        req,
      });
      return res.status(201).json({ success: true, data: created });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // GET /api/approvals/pending — "Pending Approvals" dashboard for the logged-in approver
  async pending(req, res) {
    try {
      console.log("[CONTROLLER] req.models at entry?", !!req.models, "route:", req.originalUrl);
      const items = await ApprovalEngineService.getPendingForUser(req);
      return res.json({ success: true, data: items, total: items.length });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // GET /api/approvals/my-actions — "My Approvals" (actions I have taken)
  async myActions(req, res) {
    try {
      const items = await ApprovalEngineService.getMyApprovalActions(req);
      return res.json({ success: true, data: items, total: items.length });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // GET /api/approvals/:id — Approval Details (workflow + levels + history + comments)
  async getById(req, res) {
    try {
      const details = await ApprovalEngineService.getDetails(req, req.params.id);
      if (!details) return res.status(404).json({ success: false, message: "Approval record not found" });
      return res.json({ success: true, data: details });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // GET /api/approvals/:id/timeline — Approval Timeline / Approval Tree
  async timeline(req, res) {
    try {
      const timeline = await ApprovalEngineService.getTimeline(req, req.params.id);
      return res.json({ success: true, data: timeline });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },

  // GET /api/approvals/document/:documentId — look up the approval run for a document
  async getByDocument(req, res) {
    try {
      const { DocumentApproval } = req.models;
      const documentApproval = await DocumentApproval.findOne({
        where: { documentId: req.params.documentId },
      });
      if (!documentApproval) {
        return res.json({ success: true, approvalRequired: false, data: null });
      }
      const details = await ApprovalEngineService.getDetails(req, documentApproval.id);
      return res.json({ success: true, approvalRequired: true, data: details });
    } catch (error) {
      return handleEngineError(res, error);
    }
  },
};

module.exports = ApprovalController;