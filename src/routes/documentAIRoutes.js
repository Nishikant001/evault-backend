// src/routes/documentAIRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const { loadSubscription, requireAI } = require("../middleware/subscriptionMiddleware"); // NEW (Subscription Management System)
const {
  summarize,
  explain,
  compare,
  findDuplicates,
  missingMetadata,
  ocrInconsistencies,
  validateTotals,
  autoClassify,
  autoTag,
  suggestFolder,
  reindex,
  semanticSearch,
  metadataSearch,
  ocrSearch,
} = require("../controllers/documentAIController");

const READ_ROLES = ["SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"];
const WRITE_ROLES = ["SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader"];

// Every route here is an AI Document Assistant feature -> gate the whole
// router behind requireAI once. FREE tenants never reach a provider call.
router.use(auth, loadSubscription, requireAI);

// ── Single/paired document AI features ────────────────────────
router.get("/documents/:id/summarize", role(...READ_ROLES), summarize);
router.get("/documents/:id/explain", role(...READ_ROLES), explain);
router.post("/documents/compare", role(...READ_ROLES), compare);
router.get("/documents/:id/duplicates", role(...READ_ROLES), findDuplicates);
router.get("/documents/:id/missing-metadata", role(...READ_ROLES), missingMetadata);
router.get("/documents/:id/ocr-inconsistencies", role(...READ_ROLES), ocrInconsistencies);
router.get("/documents/:id/validate-totals", role(...READ_ROLES), validateTotals);
router.get("/documents/:id/auto-classify", role(...WRITE_ROLES), autoClassify);
router.get("/documents/:id/auto-tag", role(...WRITE_ROLES), autoTag);
router.get("/documents/:id/folder-suggestions", role(...WRITE_ROLES), suggestFolder);
router.post("/documents/:id/reindex", role(...WRITE_ROLES), reindex);

// ── Search ─────────────────────────────────────────────────────
router.get("/search/semantic", role(...READ_ROLES), semanticSearch);
router.get("/search/metadata", role(...READ_ROLES), metadataSearch);
router.get("/search/ocr", role(...READ_ROLES), ocrSearch);

module.exports = router;
