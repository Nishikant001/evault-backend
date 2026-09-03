// src/routes/documentRoutes.js
const express = require("express");
const multer = require("multer");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const {
  loadSubscription,
  requireActiveSubscription,
  requirePaidPlan,
  enforceDailyUploadLimit,
} = require("../middleware/subscriptionMiddleware"); // NEW (Subscription Management System)
const {
  uploadDocument,
  listDocuments,
  getDocument,
  getDocumentFromSap,
  deleteDocument,
  getDocumentStatus,
  reprocessOcr,
  generateTcode,
  finalizeDocument,
  getDocumentActivity,
  searchByTcode,
  searchDocuments,
    searchAdvanced,
  viewDocument,
  downloadDocument,
  getDocumentThumbnail,
  getDocumentVersions,
} = require("../controllers/documentController");

// multer: keep file in memory — we pass buffer directly to SAP
// Never write to disk (no local storage of binaries)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
});

// POST   /api/documents/upload           → upload document (binary → SAP, metadata → DB)
// GET    /api/documents                  → list documents for tenant
// GET    /api/documents/:id              → get document metadata from our DB
// GET    /api/documents/:id/sap          → fetch document info from SAP by sapDocumentId
// DELETE /api/documents/:id              → soft delete
//
// Subscription Management System: loadSubscription runs on every route
// (non-blocking — it just attaches req.tenant/req.subscription/req.planFeatures
// so documentController can branch FREE-vs-PAID storage/watermark behavior).
// requireActiveSubscription is applied only to routes that create/modify
// state, so a FREE tenant whose trial has expired can still view/download
// what they already uploaded, but cannot upload/finalize/delete further
// until they upgrade.
router.use(auth, loadSubscription);

router.post(
  "/upload",
  requireActiveSubscription(),
  enforceDailyUploadLimit(), // Task 4 — FREE tenants: max 5 uploads/day (DB-backed, resets daily)
  role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader"),
  upload.single("file"),
  uploadDocument
);
router.get("/", role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"),listDocuments);
// IMPORTANT: /search must be registered before /:id, otherwise Express
// would match "/search" as :id = "search" (see brief section 24).
router.get(
  "/search",
  role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"),
  searchDocuments
);
router.get(
  "/search/advanced",
  role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"),
  searchAdvanced
);
router.get("/:id", role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"), getDocument);
// Raw SAP metadata lookup — paid-plan only (FREE documents never have a
// sapDocumentId, but this is blocked explicitly rather than relying on that).
router.get("/:id/sap", requirePaidPlan(), getDocumentFromSap);
router.get("/:id/activity", getDocumentActivity);
router.get(
  "/search/tcode",
  searchByTcode
);

router.get(
  "/:id/view",
  role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"),
  viewDocument
);

router.get(
  "/:id/download",
  role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"),
  downloadDocument
);

router.get(
  "/:id/thumbnail",
  role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"),
  getDocumentThumbnail
);
router.delete("/:id", requireActiveSubscription(), role("SuperAdmin","TenantAdmin"), deleteDocument);
router.get("/:id/status", role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"), getDocumentStatus);

// POST /api/documents/:id/reprocess-ocr → re-run OCR + dynamic metadata
// mapping for an existing document (e.g. after fixing an OCR alias),
// without needing to re-upload the file. Tenant Admin / Uploader only.
router.post(
  "/:id/reprocess-ocr",
  requireActiveSubscription(),
  role("SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader"),
  reprocessOcr
);

router.post("/:id/generate-tcode", requireActiveSubscription(), generateTcode);

router.post(
  "/:id/finalize",
  requireActiveSubscription(),
  finalizeDocument,
);

router.get("/:id/versions", role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"), getDocumentVersions);


module.exports = router;
