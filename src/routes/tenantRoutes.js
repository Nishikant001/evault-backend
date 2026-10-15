const express = require("express");

const router = express.Router();

const authMiddleware =
require("../middleware/authMiddleware");

const roleMiddleware =
require("../middleware/roleMiddleware");

const TenantController =
require("../controllers/tenantController");

// Self-service — any authenticated role, scoped to the caller's own
// tenant (see TenantController.getMyMetadata). Must be declared before any
// "/:id"-shaped route so Express doesn't try to match "me" as an :id.
router.get(
  "/me/metadata",
  authMiddleware,
  TenantController.getMyMetadata
);

router.post(
  "/",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.create
);

router.get(
  "/",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.getAll
);

router.get(
  "/storage",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.getStorageOverview
);

router.post(
  "/storage/refresh",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.refreshStorage
);


// PHASE D — provisioning APIs (brief section 13). Declared before
// "/:id" so Express routes "/:id/provision" correctly rather than
// matching ":id" = "provision" against a different verb.
router.get(
  "/:id/storage",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.getStorage
);

router.put(
  "/:id/storage/quota",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.updateStorageQuota
);

router.get(
  "/:id",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.getById
);

router.post(
  "/:id/provision",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.provision
);

router.post(
  "/:id/retry-provisioning",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.retryProvisioning
);

router.put(
  "/:id",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.update
);

// PHASE 3 (multi-ERP sync management), PART 2 — "Set Default" action on
// the Super Admin tenant ERP assignment UI.
router.put(
  "/:id/erp-connections/:erpConfigId/default",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.setDefaultErpConnection
);

router.delete(
  "/:id",
  authMiddleware,
  roleMiddleware("SuperAdmin"),
  TenantController.delete
);

module.exports = router;