// src/routes/tenantErpRoutes.js
//
// MULTI-ERP FIX (brief item #1: "Tenant Admin is effectively seeing only
// SAP"): sapSyncController.js already contained listAllTenantErpConnections
// — a correct, already-written endpoint returning every active SAP +
// Oracle + Custom connection assigned to the tenant — but it was exported
// and then never require()'d by any route file, and the frontend only ever
// called SapSyncApi.listErpConnections() (GET /api/sap-sync/erp-connections),
// which is intentionally hard-filtered to erpType "SAP" because it feeds
// the SAP Sync pages specifically. With no other endpoint wired up, "all
// of a tenant's ERP connections" was simply unreachable — Tenant Admin
// really could only ever see SAP, no matter what SuperAdmin assigned.
//
// This file is the generic counterpart: NOT gated behind requireSAP (an
// Oracle-only tenant, with no SAP feature flag at all, must still be able
// to see and use its Oracle connection), just auth + tenant-scoped role.
"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");

const { listAllTenantErpConnections } = require("../controllers/sapSyncController");
const {
  testGenericErpConnection,
  syncGenericErpEntity,
} = require("../controllers/genericErpController");

const VIEW_ROLES = ["SuperAdmin", "TenantAdmin"];

// GET /api/tenant-erp/connections — every active ERP connection (any type)
// assigned to the tenant. This is what the Tenant Admin "ERP Integration"
// screen renders.
router.get("/connections", auth, role(...VIEW_ROLES), listAllTenantErpConnections);

// POST /api/tenant-erp/connections/:erpConfigId/test — works for any ERP
// type via ErpFactory (SAP included, though Tenant Admin normally uses the
// SAP Sync module's own test action for SAP).
router.post("/connections/:erpConfigId/test", auth, role(...VIEW_ROLES), testGenericErpConnection);

// POST /api/tenant-erp/connections/:erpConfigId/sync/:entity — CATEGORY or
// DOCUMENT_TYPE master sync for a non-SAP connection. SAP connections are
// rejected here with a clear message pointing at the SAP Sync module,
// which remains the SAP-specific, battle-tested path.
router.post("/connections/:erpConfigId/sync/:entity", auth, role(...VIEW_ROLES), syncGenericErpEntity);

module.exports = router;
