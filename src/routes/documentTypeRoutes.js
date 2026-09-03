// src/routes/documentTypeRoutes.js
const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/authMiddleware");
const role    = require("../middleware/roleMiddleware");
const {
  createDocumentType,
  listDocumentTypes,
  getDocumentType,
  updateDocumentType,
  deleteDocumentType,
} = require("../controllers/documentTypeController");

// POST   /api/document-types            → create doc type under a category
// GET    /api/document-types            → list (?categoryId=)
// GET    /api/document-types/:id        → get single (used before upload to get schema)
// PUT    /api/document-types/:id        → update
// DELETE /api/document-types/:id        → soft delete

router.post("/",    auth, role("TenantAdmin"), createDocumentType);
router.get( "/",    auth,role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"),listDocumentTypes);
router.get( "/:id", auth,role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"),getDocumentType);
router.put( "/:id", auth, role("TenantAdmin"), updateDocumentType);
router.delete("/:id", auth, role("TenantAdmin"), deleteDocumentType);

module.exports = router;