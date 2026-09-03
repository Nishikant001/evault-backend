// src/routes/plantRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const {
  createPlant,
  listPlants,
  getPlant,
  updatePlant,
  deletePlant,
} = require("../controllers/plantController");

// POST   /api/plants           → create a plant under a company code
// GET    /api/plants           → list plants (?companyCodeId=)
// GET    /api/plants/:id       → get a single plant
// PUT    /api/plants/:id       → update a plant
// DELETE /api/plants/:id       → soft delete a plant

router.post(
  "/",
  auth,
  role("SuperAdmin", "TenantAdmin"),
  createPlant
);

router.get(
  "/",
  auth,
  role("SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"),
  listPlants
);

router.get(
  "/:id",
  auth,
  role("SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"),
  getPlant
);

router.put(
  "/:id",
  auth,
  role("SuperAdmin", "TenantAdmin"),
  updatePlant
);

router.delete(
  "/:id",
  auth,
  role("SuperAdmin", "TenantAdmin"),
  deletePlant
);

module.exports = router;
