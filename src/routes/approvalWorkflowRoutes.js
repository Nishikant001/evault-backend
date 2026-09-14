// src/routes/approvalWorkflowRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { requireTenantModule } = require("../middleware/tenantModuleMiddleware");
const role = require("../middleware/roleMiddleware");
const ApprovalWorkflowController = require("../controllers/approvalWorkflowController");

// Only Tenant/Super Admins configure the approval matrix.
const BUILDER_ROLES = ["SuperAdmin", "TenantAdmin"];
// Broader set of roles allowed to just VIEW the configured matrix
// (e.g. so an approver can see why they're in a chain).
const VIEWER_ROLES = [...BUILDER_ROLES, "BranchManager", "DeptHead", "Manager", "Approver"];

router.post("/", auth, requireTenantModule("approval_engine"), role(...BUILDER_ROLES), ApprovalWorkflowController.create);
router.get("/", auth, requireTenantModule("approval_engine"), role(...VIEWER_ROLES), ApprovalWorkflowController.list);
router.get("/by-combo", auth, requireTenantModule("approval_engine"), role(...VIEWER_ROLES), ApprovalWorkflowController.getByCombo);
router.get("/:id", auth, requireTenantModule("approval_engine"), role(...VIEWER_ROLES), ApprovalWorkflowController.getById);
router.put("/:id", auth, requireTenantModule("approval_engine"), role(...BUILDER_ROLES), ApprovalWorkflowController.update);
router.delete("/:id", auth, requireTenantModule("approval_engine"), role(...BUILDER_ROLES), ApprovalWorkflowController.remove);
router.post("/levels/:levelId/assignments", auth, requireTenantModule("approval_engine"), role(...BUILDER_ROLES), ApprovalWorkflowController.assignApprovers);

module.exports = router;
