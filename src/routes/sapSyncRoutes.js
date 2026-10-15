// src/routes/sapSyncRoutes.js

const express = require("express");
const router = express.Router();

const auth = require("../middleware/authMiddleware");
const {
  requireTenantModule,
} = require("../middleware/tenantModuleMiddleware");
const role = require("../middleware/roleMiddleware");

const {
  loadSubscription,
  requireSAP,
} = require("../middleware/subscriptionMiddleware");

const {
  SYNC_EXECUTE_ROLES,
  SYNC_VIEW_ROLES,
} = require("../constants/sapSyncConstants");

const {
  syncMasters,
  syncDocuments,
  syncAllMasters,
  syncAllDocuments,
  retryFailedSync,

  listSapErpConnections,

  // PHASE 3 — Tenant Admin default ERP
  setDefaultSapErpConnection,

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

// ─────────────────────────────────────────────────────────────
// SAP Sync Router Protection
// ─────────────────────────────────────────────────────────────
//
// Every route in this file talks to SAP.
//
// auth
//   ↓
// tenant module permission
//   ↓
// subscription validation
//   ↓
// ERP/SAP enabled validation
//
// FREE tenants never reach the controllers below.
//

router.use(
  auth,
  requireTenantModule("sap_sync"),
  loadSubscription,
  requireSAP
);

// ─────────────────────────────────────────────────────────────
// Sync Execution
// ─────────────────────────────────────────────────────────────
//
// POST /api/sap-sync/masters
// POST /api/sap-sync/documents
//
// erpConfigId is optional.
//
// Existing single-ERP behavior remains unchanged.
//
// Multiple ERP tenant:
//
// {
//   "erpConfigId": 123
// }
//

router.post(
  "/masters/all",
  role(...SYNC_EXECUTE_ROLES),
  syncAllMasters
);

router.post(
  "/masters",
  role(...SYNC_EXECUTE_ROLES),
  syncMasters
);

router.post(
  "/documents/all",
  role(...SYNC_EXECUTE_ROLES),
  syncAllDocuments
);

router.post(
  "/documents",
  role(...SYNC_EXECUTE_ROLES),
  syncDocuments
);

router.post(
  "/retry",
  role(...SYNC_EXECUTE_ROLES),
  retryFailedSync
);

// ─────────────────────────────────────────────────────────────
// ERP Connections
// ─────────────────────────────────────────────────────────────
//
// GET
// /api/sap-sync/erp-connections
//
// Returns the ERP connections assigned to the authenticated
// tenant.
//
// SAP Sync selector uses this endpoint.
//

router.get(
  "/erp-connections",
  role(...SYNC_VIEW_ROLES),
  listSapErpConnections
);

// ─────────────────────────────────────────────────────────────
// Default ERP
// ─────────────────────────────────────────────────────────────
//
// PUT
// /api/sap-sync/erp-connections/:erpConfigId/default
//
// Tenant Admin uses this endpoint to change the tenant's
// default ERP connection.
//
// Important:
//
// - It must belong to the authenticated tenant.
// - It must be active.
// - Backend controller must enforce the one-default rule.
// - Changing the default does NOT remove the ERP connection.
// - Changing the default does NOT delete SAP configuration.
// - SAP Sync must still explicitly resolve only SAP connections.
//

router.put(
  "/erp-connections/:erpConfigId/default",
  role(...SYNC_EXECUTE_ROLES),
  setDefaultSapErpConnection
);

// ─────────────────────────────────────────────────────────────
// Sync Status / Logs
// ─────────────────────────────────────────────────────────────

router.get(
  "/status",
  role(...SYNC_VIEW_ROLES),
  getSyncStatus
);

router.get(
  "/logs",
  role(...SYNC_VIEW_ROLES),
  getSyncLogs
);

router.get(
  "/retry-queue",
  role(...SYNC_VIEW_ROLES),
  getRetryQueue
);

// ─────────────────────────────────────────────────────────────
// Master Synchronization
// ─────────────────────────────────────────────────────────────
//
// GET /api/sap-sync/masters/:type
//
// type:
//   departments
//   categories
//   document-types
//

router.get(
  "/masters/:type",
  role(...SYNC_VIEW_ROLES),
  listMasters
);

// ─────────────────────────────────────────────────────────────
// Document Synchronization
// ─────────────────────────────────────────────────────────────

router.get(
  "/documents",
  role(...SYNC_VIEW_ROLES),
  listSyncDocuments
);

router.get(
  "/documents/:id",
  role(...SYNC_VIEW_ROLES),
  getSyncDocumentDetail
);

// ─────────────────────────────────────────────────────────────
// Pending Classification
// ─────────────────────────────────────────────────────────────

router.get(
  "/pending-classification",
  role(...SYNC_VIEW_ROLES),
  listPendingClassification
);

router.get(
  "/pending-classification/:id/view",
  role(...SYNC_VIEW_ROLES),
  viewPendingClassificationDocument
);

router.post(
  "/pending-classification/:id/assign",
  role(...SYNC_EXECUTE_ROLES),
  assignClassification
);

router.post(
  "/pending-classification/bulk-assign",
  role(...SYNC_EXECUTE_ROLES),
  bulkAssignClassification
);

// ─────────────────────────────────────────────────────────────
// Scheduler Management
// ─────────────────────────────────────────────────────────────

router.get(
  "/schedules",
  role(...SYNC_VIEW_ROLES),
  listSchedules
);

router.put(
  "/schedules/:id",
  role(...SYNC_EXECUTE_ROLES),
  updateSchedule
);

router.post(
  "/schedules/:id/run-now",
  role(...SYNC_EXECUTE_ROLES),
  runScheduleNow
);

// ─────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────

router.get(
  "/settings",
  role(...SYNC_VIEW_ROLES),
  getSettings
);

router.put(
  "/settings",
  role(...SYNC_EXECUTE_ROLES),
  updateSettings
);

router.post(
  "/settings/test-connection",
  role(...SYNC_EXECUTE_ROLES),
  testTenantConnection
);

module.exports = router;