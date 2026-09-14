// src/routes/categoryRoutes.js
const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/authMiddleware");
const role    = require("../middleware/roleMiddleware");
const {
  createCategory,
  listCategories,
  updateCategory,
  deleteCategory,
} = require("../controllers/categoryController");

// All routes: tenant-scoped (Admin or TenantUser can manage their own categories)

// POST   /api/categories          → create category under a dept
// GET    /api/categories          → list categories (?departmentId=)
// PUT    /api/categories/:id      → update category
// DELETE /api/categories/:id      → soft delete category

router.post(   "/",    auth, role("TenantAdmin"), createCategory);
router.get(    "/",    auth, role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"),listCategories);
router.put(    "/:id", auth, role("TenantAdmin"), updateCategory);
router.delete( "/:id", auth, role("TenantAdmin"), deleteCategory);

module.exports = router;