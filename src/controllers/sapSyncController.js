// src/controllers/sapSyncController.js
//
// Owns the 6 original SAP Master/Document Synchronization endpoints:
// run master sync, run document sync, retry failed sync, get status,
// get logs, get retry queue. All actual sync logic lives in
// services/sapSyncOrchestrator.js (single entry point shared with the
// cron scheduler) — this controller is a thin REST wrapper around it,
// plus read-only listing endpoints backed directly by the SapSyncLog /
// SapSyncRetryQueue models.
//
// sapSyncExtController.js extends this module with per-record listings,
// Pending Classification, Scheduler Management, and Settings — kept in a
// separate file so this one stays focused and untouched by that work.

const { Op } = require("sequelize");
// PHASE G — Tenant is a Master DB model. SapSyncLog/SapSyncRetryQueue are
// tenant-side; resolveTenantId() above allows SuperAdmin to pass an
// arbitrary target tenantId (not necessarily their own — SuperAdmin has
// no req.models at all), so these resolve the TARGET tenant's own
// connection via getTenantConnection(tenantId) rather than req.models.
const { getTenantConnection } = require("../services/tenantConnectionManager");
const Orchestrator = require("../services/sapSyncOrchestrator");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const { SAP_SYNC_TRIGGER, SAP_SYNC_ENTITY_TYPE } = require("../constants/sapSyncConstants");

function resolveTenantId(req) {
  if (req.user.role === "SuperAdmin") {
    const tenantId = req.body?.tenantId || req.query?.tenantId;
    return tenantId ? parseInt(tenantId, 10) : null;
  }
  return req.user.tenantId;
}

function pagination(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 200);
  return { page, limit, offset: (page - 1) * limit };
}

// ── POST /api/sap-sync/masters ────────────────────────────────
// Runs SAP Master Synchronization (Department -> Category -> DocumentType)
const syncMasters = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });

    const tenant = await req.masterModels.Tenant.findByPk(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: "Tenant not found" });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action: AUDIT_ACTIONS.SAP_MASTER_SYNC_TRIGGERED,
      tenantId,
      remarks: "SAP Master Synchronization triggered manually",
      status: AUDIT_STATUS.PENDING,
    });

    try {
      const result = await Orchestrator.runMasterSync({
        tenantId,
        triggerType: SAP_SYNC_TRIGGER.MANUAL,
        triggeredBy: req.user.id,
      });

      await AuditService.log({
        req,
        module: AUDIT_MODULES.SAP_SYNC,
        action: AUDIT_ACTIONS.SAP_MASTER_SYNC_COMPLETED,
        tenantId,
        newValue: result,
        remarks: "SAP Master Synchronization completed",
        status: AUDIT_STATUS.SUCCESS,
      });

      return res.json({ success: true, data: result });
    } catch (syncError) {
      await AuditService.log({
        req,
        module: AUDIT_MODULES.SAP_SYNC,
        action: AUDIT_ACTIONS.SAP_MASTER_SYNC_FAILED,
        tenantId,
        remarks: `SAP Master Synchronization failed: ${syncError.message}`,
        status: AUDIT_STATUS.FAILED,
      });
      return res.status(502).json({ success: false, message: syncError.message });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── POST /api/sap-sync/documents ──────────────────────────────
// Runs SAP Document Synchronization (DocumentMetaSet, HasOriginal = 'X' only)
const syncDocuments = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });

    const tenant = await req.masterModels.Tenant.findByPk(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: "Tenant not found" });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action: AUDIT_ACTIONS.SAP_DOCUMENT_SYNC_TRIGGERED,
      tenantId,
      remarks: "SAP Document Synchronization triggered manually",
      status: AUDIT_STATUS.PENDING,
    });

    try {
      const result = await Orchestrator.runDocumentSync({
        tenantId,
        triggerType: SAP_SYNC_TRIGGER.MANUAL,
        triggeredBy: req.user.id,
      });

      await AuditService.log({
        req,
        module: AUDIT_MODULES.SAP_SYNC,
        action: AUDIT_ACTIONS.SAP_DOCUMENT_SYNC_COMPLETED,
        tenantId,
        newValue: result,
        remarks: "SAP Document Synchronization completed",
        status: AUDIT_STATUS.SUCCESS,
      });

      return res.json({ success: true, data: result });
    } catch (syncError) {
      await AuditService.log({
        req,
        module: AUDIT_MODULES.SAP_SYNC,
        action: AUDIT_ACTIONS.SAP_DOCUMENT_SYNC_FAILED,
        tenantId,
        remarks: `SAP Document Synchronization failed: ${syncError.message}`,
        status: AUDIT_STATUS.FAILED,
      });
      return res.status(502).json({ success: false, message: syncError.message });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── POST /api/sap-sync/retry ──────────────────────────────────
// Body: { entityType? } — DEPARTMENT | CATEGORY | DOCUMENT_TYPE | DOCUMENT
// Re-attempts everything currently due in the Retry Queue (optionally
// scoped to a single entityType).
const retryFailedSync = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });

    const { entityType } = req.body || {};
    if (entityType && !Object.values(SAP_SYNC_ENTITY_TYPE).includes(entityType)) {
      return res.status(400).json({
        success: false,
        message: `entityType must be one of: ${Object.values(SAP_SYNC_ENTITY_TYPE).join(", ")}`,
      });
    }

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action: AUDIT_ACTIONS.SAP_SYNC_RETRY_TRIGGERED,
      tenantId,
      remarks: entityType ? `Retry triggered for ${entityType} records` : "Retry triggered for all pending records",
      status: AUDIT_STATUS.PENDING,
    });

    const result = await Orchestrator.runRetry({
      tenantId,
      entityType,
      triggerType: SAP_SYNC_TRIGGER.RETRY,
      triggeredBy: req.user.id,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action: AUDIT_ACTIONS.SAP_SYNC_RETRY_COMPLETED,
      tenantId,
      newValue: result,
      remarks: "Retry run completed",
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── GET /api/sap-sync/status ──────────────────────────────────
// Returns the most recent MASTER and DOCUMENT run for the tenant, plus
// the current retry backlog count.
const getSyncStatus = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { SapSyncLog, SapSyncRetryQueue } = (await getTenantConnection(tenantId)).models;

    const [lastMasterRun, lastDocumentRun, retryBacklog] = await Promise.all([
      SapSyncLog.findOne({ where: { tenantId, syncType: "MASTER" }, order: [["createdAt", "DESC"]] }),
      SapSyncLog.findOne({ where: { tenantId, syncType: "DOCUMENT" }, order: [["createdAt", "DESC"]] }),
      SapSyncRetryQueue.count({ where: { tenantId, status: { [Op.in]: ["PENDING", "RETRYING"] } } }),
    ]);

    return res.json({
      success: true,
      data: {
        lastMasterRun,
        lastDocumentRun,
        retryBacklogCount: retryBacklog,
        isRunning:
          lastMasterRun?.status === "RUNNING" || lastDocumentRun?.status === "RUNNING",
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── GET /api/sap-sync/logs ────────────────────────────────────
// Query: page, limit, syncType (MASTER|DOCUMENT), status, triggerType, dateFrom, dateTo
const getSyncLogs = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { SapSyncLog } = (await getTenantConnection(tenantId)).models;

    const { syncType, status, triggerType, dateFrom, dateTo } = req.query;
    const { page, limit, offset } = pagination(req.query);

    const where = { tenantId };
    if (syncType) where.syncType = syncType;
    if (status) where.status = status;
    if (triggerType) where.triggerType = triggerType;
    if (dateFrom || dateTo) {
      where.startTime = {};
      if (dateFrom) where.startTime[Op.gte] = new Date(dateFrom);
      if (dateTo) where.startTime[Op.lte] = new Date(dateTo);
    }

    const { rows, count } = await SapSyncLog.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    return res.json({
      success: true,
      data: rows,
      pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) || 1 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── GET /api/sap-sync/retry-queue ─────────────────────────────
// Query: page, limit, entityType, status
const getRetryQueue = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { SapSyncRetryQueue } = (await getTenantConnection(tenantId)).models;

    const { entityType, status } = req.query;
    const { page, limit, offset } = pagination(req.query);

    const where = { tenantId };
    if (entityType) where.entityType = entityType;
    if (status) where.status = status;

    const { rows, count } = await SapSyncRetryQueue.findAndCountAll({
      where,
      order: [["nextRetryAt", "ASC"]],
      limit,
      offset,
    });

    return res.json({
      success: true,
      data: rows,
      pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) || 1 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  syncMasters,
  syncDocuments,
  retryFailedSync,
  getSyncStatus,
  getSyncLogs,
  getRetryQueue,
};