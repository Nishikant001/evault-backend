// src/routes/approvalRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { requireTenantModule } = require("../middleware/tenantModuleMiddleware");
const role = require("../middleware/roleMiddleware");
const ApprovalController = require("../controllers/approvalController");

// Anyone who can act in an approval chain (kept broad — the engine itself
// still enforces "only the assigned approver for the current level").
const ACTOR_ROLES = ["SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Approver", "Uploader"];

router.post("/documents/:documentId/submit", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES), ApprovalController.submit);

router.get("/pending", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES), ApprovalController.pending);
router.get("/my-actions", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES), ApprovalController.myActions);
router.get("/document/:documentId", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES, "Viewer", "Auditor"), ApprovalController.getByDocument);

router.get("/:id", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES, "Viewer", "Auditor"), ApprovalController.getById);
router.get("/:id/timeline", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES, "Viewer", "Auditor"), ApprovalController.timeline);
router.post("/:id/comments", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES), ApprovalController.addComment);

router.post("/:id/approve", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES), ApprovalController.approve);
router.post("/:id/reject", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES), ApprovalController.reject);
router.post("/:id/send-back", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES), ApprovalController.sendBack);
router.post("/:id/cancel", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES), ApprovalController.cancel);
router.post("/:id/resubmit", auth, requireTenantModule("approval_engine"), role(...ACTOR_ROLES), ApprovalController.resubmit);

module.exports = router;
