// src/routes/checkInOutRoutes.js
//
// Enterprise Check-In / Check-Out. Mounted at the same "/api/documents"
// base as documentRoutes.js (see app.js) — Express matches by full path
// pattern, so these ":id/checkout" style routes never collide with the
// existing ":id" / ":id/versions" etc. routes already registered there.
const express = require("express");
const multer = require("multer");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { requireTenantModule } = require("../middleware/tenantModuleMiddleware");
const role = require("../middleware/roleMiddleware");
const {
  checkOut,
  checkIn,
  forceUnlock,
  getLockStatus,
  getVersionHistory,
} = require("../controllers/checkInOutController");
const CheckInOutService = require("../services/checkInOutService");

// Same multer config as documentRoutes.js — memory storage, 50MB cap,
// binary never touches disk except the temp file written just before SAP.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Anyone who can view a document can view its lock status / history.
const VIEW_ROLES = [
  "SuperAdmin",
  "TenantAdmin",
  "BranchManager",
  "DeptHead",
  "Manager",
  "Uploader",
  "Viewer",
  "Auditor",
  "Approver",
];

// POST   /api/documents/:id/checkout        → reserve the lock
// POST   /api/documents/:id/checkin         → upload modified file, release lock, create new version
// POST   /api/documents/:id/force-unlock    → TenantAdmin/DeptHead override
// GET    /api/documents/:id/lock-status     → current lock state
// GET    /api/documents/:id/version-history → all versions + lock state

router.post(
  "/:id/checkout",
  auth,
  requireTenantModule("dms"),
  role(...CheckInOutService.CHECKOUT_ROLES),
  checkOut
);

router.post(
  "/:id/checkin",
  auth,
  requireTenantModule("dms"),
  role(...CheckInOutService.CHECKOUT_ROLES),
  upload.single("file"),
  checkIn
);

router.post(
  "/:id/force-unlock",
  auth,
  requireTenantModule("dms"),
  role(...CheckInOutService.FORCE_UNLOCK_ROLES),
  forceUnlock
);

router.get("/:id/lock-status", auth, requireTenantModule("dms"), role(...VIEW_ROLES), getLockStatus);

router.get("/:id/version-history", auth, requireTenantModule("dms"), role(...VIEW_ROLES), getVersionHistory);

module.exports = router;
