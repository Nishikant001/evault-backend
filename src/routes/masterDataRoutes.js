const express =
require("express");

const router =
express.Router();

const authMiddleware =
require("../middleware/authMiddleware");

const { loadSubscription, requireSAP } = require("../middleware/subscriptionMiddleware"); // NEW (Subscription Management System)

const MasterDataController =
require("../controllers/masterDataController");

// This module reads live SAP master data (see sapEntityResolver usage in
// masterDataController.js) -> gated behind requireSAP so FREE tenants
// never reach a SAP call.
router.get(
  "/departments",
  authMiddleware,
  loadSubscription,
  requireSAP,
  MasterDataController.departments
);

router.get(
  "/categories",
  authMiddleware,
  loadSubscription,
  requireSAP,
  MasterDataController.categories
);

module.exports =
router;