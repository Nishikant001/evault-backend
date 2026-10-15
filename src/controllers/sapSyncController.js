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

const {
  AUDIT_ACTIONS,
  AUDIT_MODULES,
  AUDIT_STATUS,
} = require("../constants/auditActions");

const {
  SAP_SYNC_TRIGGER,
  SAP_SYNC_ENTITY_TYPE,
} = require("../constants/sapSyncConstants");


// ============================================================
// TENANT RESOLUTION
// ============================================================

function resolveTenantId(req) {
  if (req.user.role === "SuperAdmin") {
    const tenantId = req.body?.tenantId || req.query?.tenantId;
    return tenantId ? parseInt(tenantId, 10) : null;
  }

  return req.user.tenantId;
}


// ============================================================
// ERP CONFIGURATION ID RESOLUTION
// ============================================================

// PHASE 2 (multi-ERP sync)
// Supports both:
// body.erpConfigId
// query.erpConfigId
//
// Existing single-ERP calls remain backward compatible because
// undefined is returned when no ERP is explicitly supplied.

function resolveErpConfigId(req) {
  const raw =
    req.body?.erpConfigId ??
    req.query?.erpConfigId;

  if (
    raw === undefined ||
    raw === null ||
    raw === ""
  ) {
    return undefined;
  }

  const parsed = parseInt(raw, 10);

  return Number.isInteger(parsed)
    ? parsed
    : undefined;
}


// FLEXIBLE MULTI-SELECT SYNC
// Parses an optional array of ERP ids (body.erpConfigIds or a
// comma-separated query.erpConfigIds) for "Sync Selected".
//
// Returns:
//   undefined -> caller did not send the field (old single-ERP behavior)
//   number[]  -> de-duplicated list of valid ids (may be empty if the
//                field was sent but held nothing valid)
function resolveErpConfigIds(req) {
  let raw = req.body?.erpConfigIds ?? req.query?.erpConfigIds;

  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }

  if (typeof raw === "string") {
    raw = raw.split(",");
  }

  if (!Array.isArray(raw)) {
    raw = [raw];
  }

  const ids = raw
    .map((value) => parseInt(value, 10))
    .filter((value) => Number.isInteger(value));

  return [...new Set(ids)];
}


// ============================================================
// TENANT ERP OWNERSHIP CHECK
// ============================================================

/**
 * Tenant-isolation guard for an explicitly-requested erpConfigId.
 *
 * Confirms the ERP is actually assigned to THIS tenant and is active
 * before anything else runs.
 *
 * Returns true and sends the HTTP response itself when the ERP is not
 * owned by the tenant.
 *
 * SAP services/orchestrator still perform their own SAP validation.
 */
async function rejectIfErpNotOwned(
  req,
  res,
  tenantId,
  erpConfigId
) {
  if (!erpConfigId) {
    return false;
  }

  const { TenantErpConnection } = req.masterModels;

  const connection =
    await TenantErpConnection.findOne({
      where: {
        tenantId,
        erpConfigId,
        isActive: true,
      },
    });

  if (!connection) {
    res.status(403).json({
      success: false,
      message:
        "The requested ERP configuration is not assigned to this tenant",
    });

    return true;
  }

  return false;
}


// ============================================================
// PAGINATION
// ============================================================

function pagination(query) {
  const page = Math.max(
    parseInt(query.page, 10) || 1,
    1
  );

  const limit = Math.min(
    Math.max(
      parseInt(query.limit, 10) || 25,
      1
    ),
    200
  );

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}


// ============================================================
// SAP MASTER SYNCHRONIZATION
// POST /api/sap-sync/masters
// ============================================================

const syncMasters = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: "tenantId is required",
      });
    }

    const tenant =
      await req.masterModels.Tenant.findByPk(
        tenantId
      );

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: "Tenant not found",
      });
    }

    // FLEXIBLE MULTI-SELECT SYNC: erpConfigIds[] present -> run the
    // selected subset. Absent -> the original single-ERP path below.
    const erpConfigIds = resolveErpConfigIds(req);

    if (erpConfigIds !== undefined) {
      return syncAllByType(req, res, "masters", erpConfigIds);
    }

    const erpConfigId =
      resolveErpConfigId(req);

    if (
      await rejectIfErpNotOwned(
        req,
        res,
        tenantId,
        erpConfigId
      )
    ) {
      return;
    }

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action:
        AUDIT_ACTIONS.SAP_MASTER_SYNC_TRIGGERED,
      tenantId,
      remarks:
        "SAP Master Synchronization triggered manually",
      status: AUDIT_STATUS.PENDING,
    });

    try {
      const result =
        await Orchestrator.runMasterSync({
          tenantId,
          triggerType:
            SAP_SYNC_TRIGGER.MANUAL,
          triggeredBy: req.user.id,
          erpConfigId,
        });

      await AuditService.log({
        req,
        module: AUDIT_MODULES.SAP_SYNC,
        action:
          AUDIT_ACTIONS.SAP_MASTER_SYNC_COMPLETED,
        tenantId,
        newValue: result,
        remarks:
          "SAP Master Synchronization completed",
        status: AUDIT_STATUS.SUCCESS,
      });

      return res.json({
        success: true,
        data: result,
      });
    } catch (syncError) {
      await AuditService.log({
        req,
        module: AUDIT_MODULES.SAP_SYNC,
        action:
          AUDIT_ACTIONS.SAP_MASTER_SYNC_FAILED,
        tenantId,
        remarks:
          `SAP Master Synchronization failed: ${syncError.message}`,
        status: AUDIT_STATUS.FAILED,
      });

      return res.status(502).json({
        success: false,
        message: syncError.message,
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


// ============================================================
// SAP DOCUMENT SYNCHRONIZATION
// POST /api/sap-sync/documents
// ============================================================

const syncDocuments = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: "tenantId is required",
      });
    }

    const tenant =
      await req.masterModels.Tenant.findByPk(
        tenantId
      );

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: "Tenant not found",
      });
    }

    // FLEXIBLE MULTI-SELECT SYNC: erpConfigIds[] present -> run the
    // selected subset. Absent -> the original single-ERP path below.
    const erpConfigIds = resolveErpConfigIds(req);

    if (erpConfigIds !== undefined) {
      return syncAllByType(req, res, "documents", erpConfigIds);
    }

    const erpConfigId =
      resolveErpConfigId(req);

    if (
      await rejectIfErpNotOwned(
        req,
        res,
        tenantId,
        erpConfigId
      )
    ) {
      return;
    }

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action:
        AUDIT_ACTIONS.SAP_DOCUMENT_SYNC_TRIGGERED,
      tenantId,
      remarks:
        "SAP Document Synchronization triggered manually",
      status: AUDIT_STATUS.PENDING,
    });

    try {
      const result =
        await Orchestrator.runDocumentSync({
          tenantId,
          triggerType:
            SAP_SYNC_TRIGGER.MANUAL,
          triggeredBy: req.user.id,
          erpConfigId,
        });

      await AuditService.log({
        req,
        module: AUDIT_MODULES.SAP_SYNC,
        action:
          AUDIT_ACTIONS.SAP_DOCUMENT_SYNC_COMPLETED,
        tenantId,
        newValue: result,
        remarks:
          "SAP Document Synchronization completed",
        status: AUDIT_STATUS.SUCCESS,
      });

      return res.json({
        success: true,
        data: result,
      });
    } catch (syncError) {
      await AuditService.log({
        req,
        module: AUDIT_MODULES.SAP_SYNC,
        action:
          AUDIT_ACTIONS.SAP_DOCUMENT_SYNC_FAILED,
        tenantId,
        remarks:
          `SAP Document Synchronization failed: ${syncError.message}`,
        status: AUDIT_STATUS.FAILED,
      });

      return res.status(502).json({
        success: false,
        message: syncError.message,
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


// ============================================================
// ACTIVE SAP CONNECTIONS
// ============================================================

/**
 * Returns only active SAP ERP connections assigned to the tenant.
 *
 * IMPORTANT:
 * Tenant-wide default is intentionally NOT used here.
 *
 * Sync All must always operate on active SAP ERP connections,
 * regardless of whether tenant default is SAP, ORACLE or CUSTOM.
 */
async function getActiveSapConnectionsForTenant(
  req,
  tenantId,
  erpConfigIds
) {
  const {
    TenantErpConnection,
    ErpConfig,
  } = req.masterModels;

  return TenantErpConnection.findAll({
    where: {
      tenantId,
      isActive: true,

      // FLEXIBLE MULTI-SELECT SYNC: optional subset filter.
      ...(Array.isArray(erpConfigIds) && erpConfigIds.length
        ? { erpConfigId: { [Op.in]: erpConfigIds } }
        : {}),
    },

    include: [
      {
        model: ErpConfig,
        as: "erpConfig",

        where: {
          erpType: "SAP",

          status: {
            [Op.in]: [
              "ACTIVE",
              "CONNECTED",
            ],
          },
        },

        required: true,

        attributes: [
          "id",
          "name",
          "erpType",
          "baseUrl",
          "status",
          "integrationMode",
        ],
      },
    ],

    order: [
      ["createdAt", "ASC"],
    ],
  });
}


// ============================================================
// SYNC ALL HELPER
// ============================================================

/**
 * Executes a Master or Document synchronization against
 * EVERY active SAP ERP connection assigned to the tenant.
 *
 * type:
 *   masters
 *   documents
 *
 * IMPORTANT:
 * This does NOT use tenant-wide default ERP.
 *
 * Example:
 *
 * Tenant default = CUSTOM
 *
 * Assigned:
 *   SAP 1 -> active
 *   SAP 2 -> active
 *   CUSTOM -> active/default
 *
 * Sync All:
 *   SAP 1
 *   SAP 2
 *
 * CUSTOM is never sent to SAP synchronization.
 */
async function syncAllByType(
  req,
  res,
  type,
  erpConfigIds
) {
  try {
    const tenantId =
      resolveTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: "tenantId is required",
      });
    }

    if (
      !["masters", "documents"].includes(type)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid sync type",
      });
    }

    const tenant =
      await req.masterModels.Tenant.findByPk(
        tenantId
      );

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: "Tenant not found",
      });
    }

    // FLEXIBLE MULTI-SELECT SYNC: an explicit (even empty) subset was
    // requested -> it must be non-empty and every id must be an active
    // SAP connection of THIS tenant. Nothing is silently dropped.
    const isSubset = Array.isArray(erpConfigIds);

    if (isSubset && erpConfigIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Select at least one ERP to sync",
      });
    }

    const connections =
      await getActiveSapConnectionsForTenant(
        req,
        tenantId,
        isSubset ? erpConfigIds : undefined
      );

    if (isSubset) {
      const found = new Set(
        connections.map((c) => Number(c.erpConfigId))
      );
      const invalid = erpConfigIds.filter((id) => !found.has(id));

      if (invalid.length) {
        return res.status(403).json({
          success: false,
          message:
            `ERP id(s) ${invalid.join(", ")} are not active SAP connections assigned to this tenant`,
        });
      }
    }

    if (!connections.length) {
      return res.status(400).json({
        success: false,
        message:
          "No active SAP ERP connections are assigned to this tenant",
      });
    }

    const results = [];

    for (const connection of connections) {
      const erpConfigId =
        connection.erpConfigId;

      const erpName =
        connection.erpConfig?.name ||
        `ERP #${erpConfigId}`;

      try {
        let result;

        if (type === "masters") {
          result =
            await Orchestrator.runMasterSync({
              tenantId,

              triggerType:
                SAP_SYNC_TRIGGER.MANUAL,

              triggeredBy:
                req.user.id,

              erpConfigId,
            });
        } else {
          result =
            await Orchestrator.runDocumentSync({
              tenantId,

              triggerType:
                SAP_SYNC_TRIGGER.MANUAL,

              triggeredBy:
                req.user.id,

              erpConfigId,
            });
        }

        results.push({
          erpConfigId,
          erpName,
          erpType:
            connection.erpConfig?.erpType ||
            "SAP",
          status: "COMPLETED",
          result,
        });
      } catch (syncError) {
        console.error(
          `[SAP Sync] ${type} sync failed for ERP ${erpConfigId}:`,
          syncError
        );

        results.push({
          erpConfigId,
          erpName,
          erpType:
            connection.erpConfig?.erpType ||
            "SAP",
          status: "FAILED",
          error: syncError.message,
        });
      }
    }

    const completed =
      results.filter(
        (item) =>
          item.status === "COMPLETED"
      ).length;

    const failed =
      results.filter(
        (item) =>
          item.status === "FAILED"
      ).length;

    return res.json({
      success: true,

      data: {
        syncType: type,

        totalErps:
          results.length,

        completed,

        failed,

        results,
      },
    });
  } catch (error) {
    console.error(
      `[SAP Sync] Sync All ${type} failed:`,
      error
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


// ============================================================
// SYNC ALL MASTERS
// ============================================================

const syncAllMasters = (
  req,
  res
) =>
  syncAllByType(
    req,
    res,
    "masters"
  );


// ============================================================
// SYNC ALL DOCUMENTS
// ============================================================

const syncAllDocuments = (
  req,
  res
) =>
  syncAllByType(
    req,
    res,
    "documents"
  );


// ============================================================
// RETRY FAILED SYNC
// POST /api/sap-sync/retry
// ============================================================

const retryFailedSync = async (
  req,
  res
) => {
  try {
    const tenantId =
      resolveTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: "tenantId is required",
      });
    }

    const {
      entityType,
    } = req.body || {};

    if (
      entityType &&
      !Object.values(
        SAP_SYNC_ENTITY_TYPE
      ).includes(entityType)
    ) {
      return res.status(400).json({
        success: false,

        message:
          `entityType must be one of: ${Object.values(
            SAP_SYNC_ENTITY_TYPE
          ).join(", ")}`,
      });
    }

    // MULTI-ERP FIX: the frontend (SapSyncApi.triggerRetry) has always
    // sent erpConfigId when the caller selected one — this controller
    // was simply never reading it. Now it is: an explicitly selected ERP
    // is verified to belong to this tenant (same guard used by
    // syncMasters/syncDocuments) and only THAT ERP's queued failures are
    // retried, using that ERP's own configuration. Omitting erpConfigId
    // keeps the previous, unscoped "retry everything for the tenant"
    // behavior — nothing changes for single-ERP tenants.
    const erpConfigId =
      resolveErpConfigId(req);

    if (
      await rejectIfErpNotOwned(
        req,
        res,
        tenantId,
        erpConfigId
      )
    ) {
      return;
    }

    await AuditService.log({
      req,
      module:
        AUDIT_MODULES.SAP_SYNC,

      action:
        AUDIT_ACTIONS.SAP_SYNC_RETRY_TRIGGERED,

      tenantId,

      remarks:
        entityType
          ? `Retry triggered for ${entityType} records${erpConfigId ? ` (ERP #${erpConfigId})` : ""}`
          : `Retry triggered for all pending records${erpConfigId ? ` (ERP #${erpConfigId})` : ""}`,

      status:
        AUDIT_STATUS.PENDING,
    });

    const result =
      await Orchestrator.runRetry({
        tenantId,

        entityType,

        erpConfigId,

        triggerType:
          SAP_SYNC_TRIGGER.RETRY,

        triggeredBy:
          req.user.id,
      });

    await AuditService.log({
      req,
      module:
        AUDIT_MODULES.SAP_SYNC,

      action:
        AUDIT_ACTIONS.SAP_SYNC_RETRY_COMPLETED,

      tenantId,

      newValue:
        result,

      remarks:
        "Retry run completed",

      status:
        AUDIT_STATUS.SUCCESS,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


// ============================================================
// TENANT-WIDE DEFAULT ERP
// ============================================================
//
// IMPORTANT:
// This is intentionally NOT SAP-specific.
//
// Allowed tenant-wide default:
//   SAP
//   ORACLE
//   CUSTOM
//
// SAP synchronization must never blindly use this value.
// SAP sync resolves an actual SAP ERP connection separately.
//

const setDefaultTenantErpConnection =
  async (req, res) => {
    try {
      const tenantId =
        resolveTenantId(req);

      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message:
            "tenantId is required",
        });
      }

      const erpConfigId =
        parseInt(
          req.params.erpConfigId,
          10
        );

      if (
        !Number.isInteger(
          erpConfigId
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Valid erpConfigId is required",
        });
      }

      const {
        TenantErpConnection,
        ErpConfig,
      } = req.masterModels;

      // --------------------------------------------------------
      // Verify the ERP belongs to this tenant and is active.
      // --------------------------------------------------------

      const connection =
        await TenantErpConnection.findOne({
          where: {
            tenantId,
            erpConfigId,
            isActive: true,
          },

          include: [
            {
              model: ErpConfig,
              as: "erpConfig",

              required: true,

              attributes: [
                "id",
                "name",
                "erpType",
                "status",
                "integrationMode",
              ],
            },
          ],
        });

      if (!connection) {
        return res.status(403).json({
          success: false,

          message:
            "The requested ERP configuration is not assigned to this tenant or is inactive",
        });
      }

      // --------------------------------------------------------
      // Transaction
      // --------------------------------------------------------

      const sequelize =
        TenantErpConnection.sequelize;

      const transaction =
        await sequelize.transaction();

      try {
        // Remove default from ALL active ERP
        // connections for this tenant.

        await TenantErpConnection.update(
          {
            isDefault: false,
          },

          {
            where: {
              tenantId,
              isActive: true,
            },

            transaction,
          }
        );

        // Set the selected ERP as the
        // ONLY active default.

        await TenantErpConnection.update(
          {
            isDefault: true,
          },

          {
            where: {
              tenantId,
              erpConfigId,
              isActive: true,
            },

            transaction,
          }
        );

        await transaction.commit();
      } catch (transactionError) {
        await transaction.rollback();
        throw transactionError;
      }

      return res.json({
        success: true,

        message:
          "Default ERP connection updated successfully",

        data: {
          tenantId,

          erpConfigId,

          name:
            connection.erpConfig?.name ||
            null,

          erpType:
            connection.erpConfig?.erpType ||
            null,

          status:
            connection.erpConfig?.status ||
            null,

          integrationMode:
            connection.erpConfig
              ?.integrationMode ||
            null,

          isDefault: true,
        },
      });
    } catch (error) {
      console.error(
        "[Tenant ERP] Failed to set default ERP connection:",
        error
      );

      return res.status(500).json({
        success: false,

        message:
          error.message ||
          "Failed to update default ERP connection",
      });
    }
  };


// ============================================================
// BACKWARD-COMPATIBILITY ALIASES
// ============================================================
//
// These aliases intentionally remain so any existing route/import
// using the older function names does NOT break.
//
// There is only ONE actual implementation:
// setDefaultTenantErpConnection.
//

const setDefaultSapErpConnection =
  setDefaultTenantErpConnection;

const setTenantDefaultErpConnection =
  setDefaultTenantErpConnection;


// ============================================================
// GET ALL TENANT ERP CONNECTIONS
// /api/tenant-erp/connections
// ============================================================
//
// Returns ALL active ERP connections:
// SAP
// ORACLE
// CUSTOM
//
// This is intentionally different from
// listSapErpConnections(), which is SAP-only.
//

const listAllTenantErpConnections =
  async (req, res) => {
    try {
      const tenantId =
        resolveTenantId(req);

      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message:
            "tenantId is required",
        });
      }

      const {
        TenantErpConnection,
        ErpConfig,
      } = req.masterModels;

      const connections =
        await TenantErpConnection.findAll({
          where: {
            tenantId,
            isActive: true,
          },

          include: [
            {
              model: ErpConfig,
              as: "erpConfig",

              required: true,

              attributes: [
                "id",
                "name",
                "erpType",
                "baseUrl",
                "status",
                "integrationMode",
              ],
            },
          ],

          order: [
            ["createdAt", "ASC"],
          ],
        });

      return res.json({
        success: true,

        data:
          connections.map(
            (connection) => ({
              erpConfigId:
                connection.erpConfigId,

              name:
                connection.erpConfig
                  ?.name ||
                null,

              erpType:
                connection.erpConfig
                  ?.erpType ||
                null,

              status:
                connection.erpConfig
                  ?.status ||
                null,

              integrationMode:
                connection.erpConfig
                  ?.integrationMode ||
                null,

              isDefault:
                !!connection.isDefault,

              isActive:
                !!connection.isActive,
            })
          ),
      });
    } catch (error) {
      console.error(
        "[Tenant ERP] Failed to list ERP connections:",
        error
      );

      return res.status(500).json({
        success: false,

        message:
          error.message ||
          "Failed to load ERP connections",
      });
    }
  };


// ============================================================
// SAP ERP CONNECTION LIST
// GET /api/sap-sync/erp-connections
// ============================================================
//
// SAP ONLY.
//
// Oracle/Custom are intentionally excluded from this endpoint
// because this endpoint feeds SAP synchronization UI.
//

const listSapErpConnections =
  async (req, res) => {
    try {
      const tenantId =
        resolveTenantId(req);

      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message:
            "tenantId is required",
        });
      }

      const {
        TenantErpConnection,
        ErpConfig,
      } = req.masterModels;

      const connections =
        await TenantErpConnection.findAll({
          where: {
            tenantId,
            isActive: true,
          },

          include: [
  {
    model: ErpConfig,
    as: "erpConfig",

    required: true,

    attributes: [
      "id",
      "name",
      "erpType",
      "baseUrl",
      "status",
      "integrationMode",
    ],
  },
],

          order: [
            ["createdAt", "ASC"],
          ],
        });

      return res.json({
        success: true,

        data:
          connections.map(
            (connection) => ({
              erpConfigId:
                connection.erpConfigId,

              name:
                connection.erpConfig
                  ?.name ||
                null,

              erpType:
                connection.erpConfig
                  ?.erpType ||
                null,

              status:
                connection.erpConfig
                  ?.status ||
                null,

              integrationMode:
                connection.erpConfig
                  ?.integrationMode ||
                null,

              isDefault:
                Boolean(
                  connection.isDefault
                ),

              isActive:
                Boolean(
                  connection.isActive
                ),
            })
          ),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  };


// ============================================================
// SYNC STATUS
// GET /api/sap-sync/status
// ============================================================

const getSyncStatus =
  async (req, res) => {
    try {
      const tenantId =
        resolveTenantId(req);

      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message:
            "tenantId is required",
        });
      }

      const {
        SapSyncLog,
        SapSyncRetryQueue,
      } =
        (
          await getTenantConnection(
            tenantId
          )
        ).models;

      const [
        lastMasterRun,
        lastDocumentRun,
        retryBacklog,
      ] =
        await Promise.all([
          SapSyncLog.findOne({
            where: {
              tenantId,
              syncType: "MASTER",
            },

            order: [
              ["createdAt", "DESC"],
            ],
          }),

          SapSyncLog.findOne({
            where: {
              tenantId,
              syncType: "DOCUMENT",
            },

            order: [
              ["createdAt", "DESC"],
            ],
          }),

          SapSyncRetryQueue.count({
            where: {
              tenantId,

              status: {
                [Op.in]: [
                  "PENDING",
                  "RETRYING",
                ],
              },
            },
          }),
        ]);

      return res.json({
        success: true,

        data: {
          lastMasterRun,
          lastDocumentRun,

          retryBacklogCount:
            retryBacklog,

          isRunning:
            lastMasterRun?.status ===
              "RUNNING" ||
            lastDocumentRun?.status ===
              "RUNNING",
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  };


// ============================================================
// SYNC LOGS
// GET /api/sap-sync/logs
// ============================================================
//
// Query:
// page
// limit
// syncType
// status
// triggerType
// dateFrom
// dateTo
// erpConfigId
//
// SapSyncLog already supports nullable erpConfigId,
// so ERP filtering can be applied without a new migration.
//

const getSyncLogs =
  async (req, res) => {
    try {
      const tenantId =
        resolveTenantId(req);

      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message:
            "tenantId is required",
        });
      }

      const {
        SapSyncLog,
      } =
        (
          await getTenantConnection(
            tenantId
          )
        ).models;

      const {
        syncType,
        status,
        triggerType,
        dateFrom,
        dateTo,
        erpConfigId,
      } = req.query;

      const {
        page,
        limit,
        offset,
      } =
        pagination(req.query);

      const where = {
        tenantId,
      };

      if (syncType) {
        where.syncType =
          syncType;
      }

      if (status) {
        where.status =
          status;
      }

      if (triggerType) {
        where.triggerType =
          triggerType;
      }

      // --------------------------------------------------------
      // ERP FILTER
      // --------------------------------------------------------

      if (erpConfigId) {
        const parsedErpConfigId =
          parseInt(
            erpConfigId,
            10
          );

        if (
          Number.isInteger(
            parsedErpConfigId
          )
        ) {
          where.erpConfigId =
            parsedErpConfigId;
        }
      }

      // --------------------------------------------------------
      // DATE FILTER
      // --------------------------------------------------------

      if (
        dateFrom ||
        dateTo
      ) {
        where.startTime = {};

        if (dateFrom) {
          where.startTime[
            Op.gte
          ] =
            new Date(dateFrom);
        }

        if (dateTo) {
          where.startTime[
            Op.lte
          ] =
            new Date(dateTo);
        }
      }

      const {
        rows,
        count,
      } =
        await SapSyncLog.findAndCountAll(
          {
            where,

            order: [
              [
                "createdAt",
                "DESC",
              ],
            ],

            limit,
            offset,
          }
        );

      return res.json({
        success: true,

        data: rows,

        pagination: {
          total: count,
          page,
          limit,

          totalPages:
            Math.ceil(
              count / limit
            ) || 1,
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  };


// ============================================================
// RETRY QUEUE
// GET /api/sap-sync/retry-queue
// ============================================================
//
// Query:
// page
// limit
// entityType
// status
//

const getRetryQueue =
  async (req, res) => {
    try {
      const tenantId =
        resolveTenantId(req);

      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message:
            "tenantId is required",
        });
      }

      const {
        SapSyncRetryQueue,
      } =
        (
          await getTenantConnection(
            tenantId
          )
        ).models;

      const {
        entityType,
        status,
        erpConfigId,
      } = req.query;

      const {
        page,
        limit,
        offset,
      } =
        pagination(req.query);

      const where = {
        tenantId,
      };

      if (entityType) {
        where.entityType =
          entityType;
      }

      if (status) {
        where.status =
          status;
      }

      // MULTI-ERP FIX: filter the Retry Queue page down to one ERP's
      // failures when asked. Rows queued before erpConfigId existed on
      // this table have erpConfigId = NULL and are simply excluded when
      // this filter is applied, same as any other explicit filter.
      if (erpConfigId) {
        const parsedErpConfigId =
          parseInt(erpConfigId, 10);

        if (Number.isInteger(parsedErpConfigId)) {
          where.erpConfigId =
            parsedErpConfigId;
        }
      }

      const {
        rows,
        count,
      } =
        await SapSyncRetryQueue.findAndCountAll(
          {
            where,

            order: [
              [
                "nextRetryAt",
                "ASC",
              ],
            ],

            limit,
            offset,
          }
        );

      return res.json({
        success: true,

        data: rows,

        pagination: {
          total: count,
          page,
          limit,

          totalPages:
            Math.ceil(
              count / limit
            ) || 1,
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  };


// ============================================================
// EXPORTS
// ============================================================
//
// Existing names are preserved.
// Compatibility aliases are also exported so older routes/imports
// do not break.
//

module.exports = {
  // Existing SAP sync functionality
  syncMasters,
  syncDocuments,
  syncAllMasters,
  syncAllDocuments,
  retryFailedSync,

  // SAP-only ERP selector
  listSapErpConnections,

  // Tenant-wide ERP configuration
  listAllTenantErpConnections,
  setDefaultTenantErpConnection,

  // Backward-compatible names
  setDefaultSapErpConnection,
  setTenantDefaultErpConnection,

  // Status / history / retry queue
  getSyncStatus,
  getSyncLogs,
  getRetryQueue,
};