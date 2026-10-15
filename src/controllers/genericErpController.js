// src/controllers/genericErpController.js
"use strict";

const ErpFactory = require("../services/erpFactory");
const { syncEntityForTenant, SYNCABLE_ENTITIES } = require("../services/genericSyncService");

function resolveTenantId(req) {
  if (req.user.role === "SuperAdmin") {
    const tenantId = req.body?.tenantId || req.query?.tenantId;
    return tenantId ? parseInt(tenantId, 10) : null;
  }
  return req.user.tenantId;
}

/** Load + tenant-isolation-check one ERP connection by (tenantId, erpConfigId). */
async function loadOwnedConnection(req, tenantId, erpConfigId) {
  const { TenantErpConnection, ErpConfig } = req.masterModels;
  const connection = await TenantErpConnection.findOne({
    where: { tenantId, erpConfigId, isActive: true },
    include: [{ model: ErpConfig, as: "erpConfig", required: true }],
  });
  if (!connection) return null;
  return connection.erpConfig;
}

// POST /api/tenant-erp/connections/:erpConfigId/test
const testGenericErpConnection = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });

    const erpConfigId = parseInt(req.params.erpConfigId, 10);
    if (!Number.isInteger(erpConfigId)) {
      return res.status(400).json({ success: false, message: "erpConfigId must be a valid integer" });
    }

    const erpConfig = await loadOwnedConnection(req, tenantId, erpConfigId);
    if (!erpConfig) {
      return res.status(403).json({ success: false, message: "That ERP connection is not assigned to this tenant or is inactive" });
    }

    const messages = [];
    const erpService = ErpFactory.getService(erpConfig);
    await erpService.testConnection(erpConfig, (msg) => messages.push(msg));
    await erpConfig.update({ status: "CONNECTED", lastTestedAt: new Date() });

    return res.json({
      success: true,
      message: "Connection successful",
      data: { erpConfigId: erpConfig.id, erpConfigName: erpConfig.name, erpType: erpConfig.erpType, log: messages },
    });
  } catch (error) {
    if (req.params.erpConfigId) {
      // Best-effort — don't let a status-write failure mask the real error.
      try {
        const { ErpConfig } = req.masterModels;
        await ErpConfig.update({ status: "FAILED" }, { where: { id: req.params.erpConfigId } });
      } catch { /* no-op */ }
    }
    return res.status(400).json({ success: false, message: error.message });
  }
};

// POST /api/tenant-erp/connections/:erpConfigId/sync/:entity
const syncGenericErpEntity = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });

    const erpConfigId = parseInt(req.params.erpConfigId, 10);
    const entity = String(req.params.entity || "").toUpperCase();
    if (!Number.isInteger(erpConfigId)) {
      return res.status(400).json({ success: false, message: "erpConfigId must be a valid integer" });
    }
    if (!SYNCABLE_ENTITIES.includes(entity)) {
      return res.status(400).json({ success: false, message: `entity must be one of: ${SYNCABLE_ENTITIES.join(", ")}` });
    }

    const erpConfig = await loadOwnedConnection(req, tenantId, erpConfigId);
    if (!erpConfig) {
      return res.status(403).json({ success: false, message: "That ERP connection is not assigned to this tenant or is inactive" });
    }
    if (erpConfig.erpType === "SAP") {
      return res.status(400).json({ success: false, message: "This SAP connection uses SAP Master Synchronization (Masterdata Sync), not the generic ERP sync endpoint." });
    }

    const result = await syncEntityForTenant(tenantId, erpConfig, entity, req.masterModels);
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

module.exports = { testGenericErpConnection, syncGenericErpEntity };
