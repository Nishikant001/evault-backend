// ══════════════════════════════════════════════════════════════
// src/routes/departmentRoutes.js
// ══════════════════════════════════════════════════════════════
const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/authMiddleware");
const role    = require("../middleware/roleMiddleware");
const {
  createDepartment,
  listDepartments,
  updateDepartment,
  assignDepartmentsToTenant,
  getTenantDepartments,
  removeDepartmentFromTenant,
  getTenantsForDepartment,
  createDepartmentForPlant,
  getDepartmentsByPlant,
  getPlantsForDepartment,
  removeDepartmentFromPlant,
} = require("../controllers/departmentController");

// ── SuperAdmin: department master ─────────────────────────────
// POST   /api/departments                 → create dept in master list
// GET    /api/departments                 → list all active depts
// PUT    /api/departments/:id             → update dept

router.post(  "/",    auth, role("TenantAdmin"),createDepartment);
router.get(   "/",    auth, role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"), listDepartments);   // Admin can read to assign
router.put(   "/:id", auth, role("SuperAdmin"),         updateDepartment);

// ── Admin: assign depts to tenants ────────────────────────────
// POST   /api/departments/assign/:tenantId    → assign dept(s) to tenant
// GET    /api/departments/tenant/:tenantId    → get depts assigned to tenant
// DELETE /api/departments/tenant/:tenantId/:departmentId → remove

router.post(  "/assign/:tenantId",              auth, role("SuperAdmin","TenantAdmin"), assignDepartmentsToTenant);
router.get(   "/tenant/:tenantId",              auth, role("SuperAdmin","TenantAdmin","BranchManager","DeptHead","Manager","Uploader","Viewer","Auditor","Approver"), getTenantDepartments);
router.delete("/tenant/:tenantId/:departmentId",auth, role("SuperAdmin","TenantAdmin"), removeDepartmentFromTenant);

// GET /api/departments/:departmentId/tenants
router.get("/:departmentId/tenants", auth, role("SuperAdmin", "TenantAdmin"), getTenantsForDepartment);

// ── Tenant-scoped Department <-> Plant mapping ──────────────────
// Department stays a GLOBAL MASTER; these endpoints only ever write to the
// tenant-scoped TenantDepartmentPlant mapping table, never to Department
// itself, so plant assignments made by one tenant can never affect another
// tenant using the same global Department (see TenantDepartmentPlant.js).
//
// POST   /api/departments/plant/:plantId                 → map an (already tenant-assigned) department to one of the tenant's own plants. Body: { departmentId }
// GET    /api/departments/plant/:plantId                 → list departments mapped to a plant, scoped to caller's tenant
// DELETE /api/departments/plant/:plantId/:departmentId    → unmap a department from a plant, scoped to caller's tenant
// GET    /api/departments/:departmentId/plants            → list the caller's own tenant's plants a department is mapped to
router.post(
  "/plant/:plantId",
  auth,
  role("SuperAdmin", "TenantAdmin"),
  createDepartmentForPlant
);
router.get(
  "/plant/:plantId",
  auth,
  role("SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"),
  getDepartmentsByPlant
);
router.delete(
  "/plant/:plantId/:departmentId",
  auth,
  role("SuperAdmin", "TenantAdmin"),
  removeDepartmentFromPlant
);
router.get(
  "/:departmentId/plants",
  auth,
  role("SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"),
  getPlantsForDepartment
);

module.exports = router;


// ══════════════════════════════════════════════════════════════
// src/routes/categoryRoutes.js
// ══════════════════════════════════════════════════════════════
// Keeping this in separate export below — see categoryRoutes.js


// ══════════════════════════════════════════════════════════════
// src/routes/documentTypeRoutes.js
// ══════════════════════════════════════════════════════════════
// Keeping this in separate export below — see documentTypeRoutes.js


// ══════════════════════════════════════════════════════════════
// src/routes/documentRoutes.js
// ══════════════════════════════════════════════════════════════
// Keeping this in separate export below — see documentRoutes.js