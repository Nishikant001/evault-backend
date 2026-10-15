const express = require("express");
const router = express.Router();

const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");

const {
  createErpConfig,
  listErpConfigs,
  getErpConfig,
  updateErpConfig,
  deleteErpConfig,
  testConnection,
  testConnectionStream,
  discoverMetadata,
  validateMapping,
  generateInboundCredentials,
  getConnectorSchema,
  validateConnector,
} = require("../controllers/erpConfigController");

// SuperAdmin only
router.post(
  "/",
  auth,
  role("SuperAdmin"),
  createErpConfig
);

router.get(
  "/",
  auth,
  role("SuperAdmin"),
  listErpConfigs
);

// DYNAMIC ERP CONNECTOR (Step 1) — must stay ABOVE "/:id" or Express
// would treat "connector-schema" as an id.
router.get(
  "/connector-schema",
  auth,
  role("SuperAdmin"),
  getConnectorSchema
);

router.post(
  "/validate-connector",
  auth,
  role("SuperAdmin"),
  validateConnector
);

router.get(
  "/:id",
  auth,
  role("SuperAdmin"),
  getErpConfig
);

router.put(
  "/:id",
  auth,
  role("SuperAdmin"),
  updateErpConfig
);

router.delete(
  "/:id",
  auth,
  role("SuperAdmin"),
  deleteErpConfig
);

router.post(
  "/:id/inbound-credentials",
  auth,
  role("SuperAdmin"),
  generateInboundCredentials
);

router.post(
  "/:id/test",
  auth,
  role("SuperAdmin"),
  testConnection
);

router.get(
  "/:id/test-stream",
  auth,
  role("SuperAdmin"),
  testConnectionStream
);

// These two were imported above from the start but never mounted here —
// discoverMetadata/validateMapping existed in erpConfigController.js and
// were fully implemented, but calling them was impossible since no route
// pointed at them. Fixed: wiring them up now, no controller changes needed.
router.get(
  "/:id/metadata",
  auth,
  role("SuperAdmin"),
  discoverMetadata
);

router.post(
  "/:id/validate",
  auth,
  role("SuperAdmin"),
  validateMapping
);

module.exports = router;