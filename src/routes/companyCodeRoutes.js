// src/routes/companyCodeRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const {
  createCompanyCode,
  listCompanyCodes,
  getCompanyCode,
  updateCompanyCode,
  deleteCompanyCode,
} = require("../controllers/companyCodeController");

// POST   /api/company-codes        → create a company code under a tenant
// GET    /api/company-codes        → list company codes for the tenant
// GET    /api/company-codes/:id    → get a single company code
// PUT    /api/company-codes/:id    → update a company code
// DELETE /api/company-codes/:id    → soft delete a company code

router.post(
  "/",
  auth,
  role("SuperAdmin", "TenantAdmin"),
  createCompanyCode
);

router.get(
  "/",
  auth,
  role("SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"),
  listCompanyCodes
);

router.get(
  "/:id",
  auth,
  role("SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"),
  getCompanyCode
);

router.put(
  "/:id",
  auth,
  role("SuperAdmin", "TenantAdmin"),
  updateCompanyCode
);

router.delete(
  "/:id",
  auth,
  role("SuperAdmin", "TenantAdmin"),
  deleteCompanyCode
);

module.exports = router;
