// src/routes/userAssignmentRoutes.js
const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/authMiddleware");
const role    = require("../middleware/roleMiddleware");
const {
  createAssignment,
  listAssignments,
  getUserAssignments,
  updateAssignment,
  revokeAssignment,
} = require("../controllers/userAssignmentController");

// Dynamic User Assignment Engine — TenantAdmin manages, SuperAdmin can view.
//
// POST   /api/user-assignments               → assign a user at DEPARTMENT/CATEGORY/DOCUMENT_TYPE level
// GET    /api/user-assignments                → list all assignments for the tenant (?userId=&status=)
// GET    /api/user-assignments/user/:userId   → full assignment set for one user
// PUT    /api/user-assignments/:id            → update/change an assignment's target
// DELETE /api/user-assignments/:id            → revoke (soft delete) an assignment

router.post(   "/",              auth, role("TenantAdmin"),               createAssignment);
router.get(    "/",              auth, role("SuperAdmin", "TenantAdmin"), listAssignments);
router.get(    "/user/:userId",  auth, role("SuperAdmin", "TenantAdmin"), getUserAssignments);
router.put(    "/:id",           auth, role("TenantAdmin"),               updateAssignment);
router.delete( "/:id",           auth, role("TenantAdmin"),               revokeAssignment);

module.exports = router;
