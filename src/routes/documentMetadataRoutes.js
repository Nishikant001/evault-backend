// src/routes/documentMetadataRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { requireTenantModule } = require("../middleware/tenantModuleMiddleware");
const role = require("../middleware/roleMiddleware");
const {
  getDocumentMetadata,
  correctDocumentMetadata,
  validateDocumentMetadata,
} = require("../controllers/documentMetadataController");

const READ_ROLES = ["SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"];
const CORRECT_ROLES = ["SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Approver"];

// GET  /api/documents/:id/metadata           → raw OCR + mapped metadata + confidence + template fields
// PUT  /api/documents/:id/metadata           → manual correction (merges into mappedMetadata, logs correctionHistory)
// POST /api/documents/:id/metadata/validate  → validate a metadata payload without saving
router.get("/:id/metadata", auth, requireTenantModule("metadata_engine"), role(...READ_ROLES), getDocumentMetadata);
router.put("/:id/metadata", auth, requireTenantModule("metadata_engine"), role(...CORRECT_ROLES), correctDocumentMetadata);
router.post("/:id/metadata/validate", auth, requireTenantModule("metadata_engine"), role(...CORRECT_ROLES), validateDocumentMetadata);

module.exports = router;
