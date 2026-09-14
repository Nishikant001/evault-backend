// src/routes/sapSyncRoutes.js
const express = require("express");
const router = express.Router();

const auth = require("../middleware/authMiddleware");
const { requireTenantModule } = require("../middleware/tenantModuleMiddleware");
const role = require("../middleware/roleMiddleware");
const { loadSubscription, requireSAP } = require("../middleware/subscriptionMiddleware"); // NEW (Subscription Management System)
const { SYNC_EXECUTE_ROLES, SYNC_VIEW_ROLES } = require("../constants/sapSyncConstants");

const {
  syncMasters,
  syncDocuments,
  retryFailedSync,
  getSyncStatus,
  getSyncLogs,
  getRetryQueue,
} = require("../controllers/sapSyncController");

const {
  listMasters,
  listSyncDocuments,
  getSyncDocumentDetail,
  listPendingClassification,
  viewPendingClassificationDocument,
  assignClassification,
  bulkAssignClassification,
  listSchedules,
  updateSchedule,
  runScheduleNow,
  getSettings,
  updateSettings,
  testTenantConnection,
  
} = require("../controllers/sapSyncExtController");

// Every route in this file talks to SAP -> gate the whole router behind
// auth + requireSAP once, instead of repeating it on every line. FREE
// tenants never reach any controller below this.
router.use(auth, requireTenantModule("sap_sync"), loadSubscription, requireSAP);

// POST   /api/sap-sync/masters      → run SAP Master Synchronization (Department -> Category -> DocumentType)
// POST   /api/sap-sync/documents    → run SAP Document Synchronization (DocumentMetaSet, HasOriginal = 'X' only)
// POST   /api/sap-sync/retry        → re-attempt everything currently due in the Retry Queue
// GET    /api/sap-sync/status       → current/last run status + retry backlog count
// GET    /api/sap-sync/logs         → paginated Sync Logs (start/end time, records, duration, status, errors)
// GET    /api/sap-sync/retry-queue  → paginated Retry Queue contents (bonus, supports the above)

router.post("/masters", role(...SYNC_EXECUTE_ROLES), syncMasters);
router.post("/documents", role(...SYNC_EXECUTE_ROLES), syncDocuments);
router.post("/retry", role(...SYNC_EXECUTE_ROLES), retryFailedSync);
router.get("/status", role(...SYNC_VIEW_ROLES), getSyncStatus);
router.get("/logs", role(...SYNC_VIEW_ROLES), getSyncLogs);
router.get("/retry-queue", role(...SYNC_VIEW_ROLES), getRetryQueue);

// ── Master Synchronization page: per-record listing ──────────
// GET /api/sap-sync/masters/:type   type = departments | categories | document-types
router.get("/masters/:type", role(...SYNC_VIEW_ROLES), listMasters);

// ── Document Synchronization page ─────────────────────────────
router.get("/documents", role(...SYNC_VIEW_ROLES), listSyncDocuments);
router.get("/documents/:id", role(...SYNC_VIEW_ROLES), getSyncDocumentDetail);

// ── Pending Classification page ───────────────────────────────
router.get("/pending-classification", role(...SYNC_VIEW_ROLES), listPendingClassification);
router.get("/pending-classification/:id/view", role(...SYNC_VIEW_ROLES), viewPendingClassificationDocument);
router.post("/pending-classification/:id/assign", role(...SYNC_EXECUTE_ROLES), assignClassification);
router.post("/pending-classification/bulk-assign", role(...SYNC_EXECUTE_ROLES), bulkAssignClassification);

// ── Scheduler Management page ─────────────────────────────────
router.get("/schedules", role(...SYNC_VIEW_ROLES), listSchedules);
router.put("/schedules/:id", role(...SYNC_EXECUTE_ROLES), updateSchedule);
router.post("/schedules/:id/run-now", role(...SYNC_EXECUTE_ROLES), runScheduleNow);

// ── Settings page ─────────────────────────────────────────────
router.get("/settings", role(...SYNC_VIEW_ROLES), getSettings);
router.put("/settings", role(...SYNC_EXECUTE_ROLES), updateSettings);
router.post("/settings/test-connection", role(...SYNC_EXECUTE_ROLES), testTenantConnection);

module.exports = router;
