// src/routes/metadataFieldRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const {
  createField,
  listFields,
  updateField,
  deleteField,
  reorderFields,
  createAlias,
  listAliases,
  deleteAlias,
} = require("../controllers/metadataFieldController");

const READ_ROLES = ["SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"];

// ── Form Builder fields ──────────────────────────────────────
// POST   /api/metadata-fields/versions/:versionId/fields      → add field (DRAFT only)
// GET    /api/metadata-fields/versions/:versionId/fields      → list fields
// PUT    /api/metadata-fields/versions/:versionId/reorder     → bulk displayOrder update
router.post("/versions/:versionId/fields", auth, role("TenantAdmin"), createField);
router.get("/versions/:versionId/fields", auth, role(...READ_ROLES), listFields);
router.put("/versions/:versionId/reorder", auth, role("TenantAdmin"), reorderFields);

// PUT    /api/metadata-fields/:fieldId       → update field (DRAFT only)
// DELETE /api/metadata-fields/:fieldId       → remove field (DRAFT only)
router.put("/:fieldId", auth, role("TenantAdmin"), updateField);
router.delete("/:fieldId", auth, role("TenantAdmin"), deleteField);

// ── OCR aliases ───────────────────────────────────────────────
// POST   /api/metadata-fields/:fieldId/aliases   → add alias
// GET    /api/metadata-fields/:fieldId/aliases   → list aliases
// DELETE /api/metadata-fields/aliases/:aliasId   → remove alias
router.post("/:fieldId/aliases", auth, role("TenantAdmin"), createAlias);
router.get("/:fieldId/aliases", auth, role(...READ_ROLES), listAliases);
router.delete("/aliases/:aliasId", auth, role("TenantAdmin"), deleteAlias);

module.exports = router;
