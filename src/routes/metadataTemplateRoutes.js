// src/routes/metadataTemplateRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { requireTenantModule } = require("../middleware/tenantModuleMiddleware");
const role = require("../middleware/roleMiddleware");
const {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  createVersion,
  listVersions,
  getVersion,
  updateVersion,
  publishVersion,
  deleteVersion,
  assignTemplate,
  getActiveAssignment,
} = require("../controllers/metadataTemplateController");

const READ_ROLES = ["SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"];

// ── Template CRUD ────────────────────────────────────────────
// POST   /api/metadata-templates              → create template (+ empty draft v1)
// GET    /api/metadata-templates              → list (?documentTypeId=)
// GET    /api/metadata-templates/:id          → get with all versions + fields
// PUT    /api/metadata-templates/:id          → update name/description/status
// DELETE /api/metadata-templates/:id          → soft delete
router.post("/", auth, requireTenantModule("metadata_engine"), role("TenantAdmin"), createTemplate);
router.get("/", auth, requireTenantModule("metadata_engine"), role(...READ_ROLES), listTemplates);
router.get("/:id", auth, requireTenantModule("metadata_engine"), role(...READ_ROLES), getTemplate);
router.put("/:id", auth, requireTenantModule("metadata_engine"), role("TenantAdmin"), updateTemplate);
router.delete("/:id", auth, requireTenantModule("metadata_engine"), role("TenantAdmin"), deleteTemplate);

// ── Versioning ───────────────────────────────────────────────
// POST   /api/metadata-templates/:id/versions          → new draft version
// GET    /api/metadata-templates/:id/versions           → list versions
router.post("/:id/versions", auth, requireTenantModule("metadata_engine"), role("TenantAdmin"), createVersion);
router.get("/:id/versions", auth, requireTenantModule("metadata_engine"), role(...READ_ROLES), listVersions);

// GET    /api/metadata-templates/versions/:versionId              → get one
// PUT    /api/metadata-templates/versions/:versionId              → update (DRAFT only)
// POST   /api/metadata-templates/versions/:versionId/publish      → publish
// DELETE /api/metadata-templates/versions/:versionId               → delete (DRAFT only)
router.get("/versions/:versionId", auth, requireTenantModule("metadata_engine"), role(...READ_ROLES), getVersion);
router.put("/versions/:versionId", auth, requireTenantModule("metadata_engine"), role("TenantAdmin"), updateVersion);
router.post("/versions/:versionId/publish", auth, requireTenantModule("metadata_engine"), role("TenantAdmin"), publishVersion);
router.delete("/versions/:versionId", auth, requireTenantModule("metadata_engine"), role("TenantAdmin"), deleteVersion);

// ── Assignment ───────────────────────────────────────────────
// POST /api/metadata-templates/assign                                       → assign a published version to a DocumentType
// GET  /api/metadata-templates/document-types/:documentTypeId/assignment    → currently live assignment
router.post("/assign", auth, requireTenantModule("metadata_engine"), role("TenantAdmin"), assignTemplate);
router.get("/document-types/:documentTypeId/assignment", auth, requireTenantModule("metadata_engine"), role(...READ_ROLES), getActiveAssignment);

module.exports = router;
