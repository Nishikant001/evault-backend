// src/controllers/tenantController.js
//
// PHASE D: repointed from the Phase 5 "../models/master" compatibility
// shim to the REAL Master DB ("../models/masterDb") — Tenant/
// TenantDatabase now live where the new registration/provisioning
// pipeline (subscriptionController.js + tenantProvisioningService.js)
// actually writes them. Static import remains correct: there's only
// ever ONE master database, so no per-request connection resolution is
// needed here (unlike tenant models).
//
// `create` is DEPRECATED — see below. provision/retryProvisioning are
// the new SuperAdmin-facing entry points into TenantProvisioningService
// (brief section 13) — reusing this existing controller/route file
// rather than standing up a parallel "/api/super-admin/tenants" prefix,
// per the brief's own "do not create duplicate APIs" instruction.

const {
  Tenant,
  TenantDatabase,
  TenantErpConnection,
  ErpConfig,
  masterSequelize,
} = require("../models/masterDb");

const { QueryTypes, Op } = require("sequelize");
const { DEFAULT_HIERARCHY } = require("../constants/tenantMetadataDefaults");
const {
  provisionTenant,
  TenantProvisioningError,
} = require("../services/tenantProvisioningService");

class TenantController {
  // GET /api/tenants/me/metadata — self-service, any authenticated role.
 static async getMyMetadata(req, res) {
  try {
    if (!req.user.tenantId) {
      return res.json({
        success: true,
        data: { hierarchy: DEFAULT_HIERARCHY, tenantType: null, erpEnabled: true, erpConfigId: null, erpConfig: null },
      });
    }

    const { ErpConfig } = require("../models/masterDb");
    const tenant = await Tenant.findByPk(req.user.tenantId, {
      include: [{ model: ErpConfig, attributes: ["id", "name", "erpType", "baseUrl", "status"] }],
    });

    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }

    const hierarchy =
      tenant.metadata && Array.isArray(tenant.metadata.hierarchy) && tenant.metadata.hierarchy.length > 0
        ? tenant.metadata.hierarchy
        : DEFAULT_HIERARCHY;

    return res.json({
      success: true,
      data: {
        hierarchy,
        tenantType: tenant.tenantType,
        erpEnabled: tenant.erpEnabled,
        erpConfigId: tenant.erpConfigId,
        erpConfig: tenant.ErpConfig
          ? { id: tenant.ErpConfig.id, name: tenant.ErpConfig.name, erpType: tenant.ErpConfig.erpType }
          : null,
        erpConnections: (tenant.erpConnections || []).map((c) => ({
          id: c.id,
          erpConfigId: c.erpConfigId,
          erpConfig: c.erpConfig ? {
            id: c.erpConfig.id, name: c.erpConfig.name, erpType: c.erpConfig.erpType,
            baseUrl: c.erpConfig.baseUrl, status: c.erpConfig.status, integrationMode: c.erpConfig.integrationMode,
          } : null,
        })),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
} 

  // POST /api/tenants — DEPRECATED.
  //
  // This used to create a bare Tenant row directly (SuperAdmin-only).
  // Since Phase 6, that would produce a BROKEN tenant: a Tenant row with
  // no TenantDatabase behind it, no physical database, no admin user —
  // anyone who then tried to log into it would hit tenantConnectionManager's
  // NOT_FOUND error. Rather than "fix" this into something that quietly
  // does the wrong thing, it's disabled outright and points at the real
  // replacement: the full provisioning pipeline in
  // companyRegistrationController.js.
  // POST /api/tenants — SuperAdmin only. Creates a PAID tenant using the
  // same provisioning pipeline as self-service FREE registration
  // (Tenant + TenantDatabase(PROVISIONING) + Subscription in one
  // transaction, then provisionTenant() for the physical DB + admin).
  static async create(req, res) {
    const {
      masterSequelize,
      Subscription,
      SubscriptionHistory,
      Plan,
    } = require("../models/masterDb");
    const {
      PLAN_CODES,
      SUBSCRIPTION_STATUS,
    } = require("../constants/subscriptionConstants");

    const { tenantName, tenantCode, name, email, password, mobileNumber, erpEnabled, erpConfigId, erpConfigIds } =
      req.body;
    const requestedErpIds = Array.from(new Set(
      (Array.isArray(erpConfigIds) ? erpConfigIds : (erpConfigId ? [erpConfigId] : []))
        .map(Number).filter(Number.isInteger)
    ));
    if (!tenantName || !tenantCode || !name || !email || !password) {
      return res.status(400).json({
        success: false,
        message:
          "tenantName, tenantCode, name, email and password are required",
      });
    }

    const t = await masterSequelize.transaction();
    let tenant;
    try {
      const exists = await Tenant.findOne({
        where: { tenantCode },
        transaction: t,
      });
      if (exists) {
        await t.rollback();
        return res
          .status(400)
          .json({ success: false, message: "Tenant Code Already Exists" });
      }

      tenant = await Tenant.create(
        { tenantName, tenantCode, status: "ACTIVE", tenantType: "PAID" },
        { transaction: t },
      );

      await TenantDatabase.create(
        { tenantId: tenant.id, status: "PROVISIONING" },
        { transaction: t },
      );

      const paidPlan = await Plan.findOne({
        where: { code: PLAN_CODES.PAID },
        transaction: t,
      });
      if (!paidPlan) throw new Error("PAID plan is not seeded");

      await Subscription.create(
        {
          tenantId: tenant.id,
          planId: paidPlan.id,
          status: SUBSCRIPTION_STATUS.ACTIVE,
          paymentStatus: "NA",
        },
        { transaction: t },
      );
      if (erpEnabled !== false && requestedErpIds.length) {
        const configs = await ErpConfig.findAll({ where: { id: requestedErpIds }, transaction: t });
        if (configs.length !== requestedErpIds.length) {
          throw new Error("One or more ERP configurations were not found");
        }
        await TenantErpConnection.bulkCreate(
          // PHASE 3 (multi-ERP sync management) — first selected
          // connection becomes the default on creation, matching the
          // legacy erpConfigId field set just below.
          requestedErpIds.map((id, index) => ({
            tenantId: tenant.id,
            erpConfigId: id,
            isActive: true,
            isDefault: index === 0,
          })),
          { transaction: t }
        );
        // Keep the legacy field populated with the first selected connection for
        // older consumers; the new mapping is authoritative for multi-connection use.
        tenant.erpConfigId = requestedErpIds[0];
        tenant.erpEnabled = true;
        await tenant.save({ transaction: t, fields: ["erpConfigId", "erpEnabled"] });
      }

      await SubscriptionHistory.create(
        {
          tenantId: tenant.id,
          fromPlanId: null,
          toPlanId: paidPlan.id,
          action: "CREATED",
          performedBy: req.user.id,
          reason: "SuperAdmin-created PAID tenant",
        },
        { transaction: t },
      );

      await t.commit();
    } catch (error) {
      await t.rollback();
      return res.status(500).json({ success: false, message: error.message });
    }

    // Master rows committed — now provision the physical DB + admin.
    try {
      const result = await provisionTenant(
        require("../models/masterDb"),
        tenant.id,
        { name, email, password, mobileNumber },
      );
      return res
        .status(201)
        .json({
          success: true,
          data: result.tenantDatabase,
          admin: result.admin,
          tenant,
        });
    } catch (error) {
      const isProvisioningError = error instanceof TenantProvisioningError;
      return res.status(502).json({
        success: false,
        message: isProvisioningError
          ? `Tenant was created but workspace setup failed (${error.step}). Use POST /api/tenants/${tenant.id}/retry-provisioning to retry.`
          : error.message,
        tenant: { id: tenant.id, tenantCode: tenant.tenantCode },
        retryable: true,
      });
    }
  }

  // GET /api/tenants — SuperAdmin only.
    // GET /api/tenants — SuperAdmin only.
 // GET /api/tenants — SuperAdmin only.
static async getAll(req, res) {
  try {
    const { ErpConfig } = require("../models/masterDb");

    const tenants = await Tenant.findAll({
      where: { status: "ACTIVE" },
      include: [
        {
          model: TenantDatabase,
          attributes: [
            "databaseName",
            "status",
            "provisionedAt",
            "documentCount",
            "userCount",
            "databaseDataBytes",
            "databaseIndexBytes",
            "databaseBytes",
            "fileBytes",
            "totalBytes",
            "databaseQuotaBytes",
            "fileQuotaBytes",
            "storageMeasuredAt",
            "provisioningAttempts",
            "failedStep",
            "lastErrorCode",
            "failedAt",
          ],
        },
        {
          model: ErpConfig,
          attributes: [
            "id",
            "name",
            "erpType",
            "baseUrl",
            "status",
            "integrationMode",
          ],
        },
        {
          model: TenantErpConnection,
          as: "erpConnections",
          where: { isActive: true },
          required: false,
          include: [
            {
              model: ErpConfig,
              as: "erpConfig",
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
        },
      ],
    });

    // Live user count from each tenant's physical users table.
    const data = await Promise.all(
      tenants.map(async (t) => {
        const json = t.toJSON();

        let userCount = 0;
        const databaseName = json.TenantDatabase?.databaseName;

        if (databaseName) {
          try {
            // databaseName comes from our own TenantDatabase table.
            // Escape backticks before using it as an identifier.
            const safeDatabaseName = String(databaseName).replace(/`/g, "``");

            const [result] = await masterSequelize.query(
              `SELECT COUNT(*) AS userCount
               FROM \`${safeDatabaseName}\`.\`users\``,
              {
                type: QueryTypes.SELECT,
              }
            );

            userCount = Number(result?.userCount || 0);
          } catch (countError) {
            console.error(
              `Failed to get live user count for tenant ${t.id}:`,
              countError.message
            );

            // Fallback to persisted count if live count fails.
            userCount = Number(json.TenantDatabase?.userCount || 0);
          }
        }

        return {
          ...json,

          erpConfig: json.ErpConfig || null,

          erpConnections: (json.erpConnections || []).map((c) => ({
            id: c.id,
            erpConfigId: c.erpConfigId,
            erpConfig: c.erpConfig || null,
            isActive: c.isActive,
            isDefault: c.isDefault,
          })),

          // LIVE count
          userCount,
        };
      })
    );

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("getAll tenants error:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}

  // GET /api/tenants/:id — SuperAdmin only. Single-tenant detail,
  // including full provisioning status (not just the summary getAll gives).
  static async getById(req, res) {
    try {
      const { ErpConfig } = require("../models/masterDb");

      const tenant = await Tenant.findByPk(req.params.id, {
        include: [
          { model: TenantDatabase },
          {
            model: TenantErpConnection,
            as: "erpConnections",
            where: { isActive: true },
            required: false,
            include: [{ model: ErpConfig, as: "erpConfig", attributes: ["id", "name", "erpType", "baseUrl", "status", "integrationMode"] }],
          },
        ],
      });
      if (!tenant) {
        return res
          .status(404)
          .json({ success: false, message: "Tenant Not Found" });
      }
      return res.json({ success: true, data: tenant });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // GET /api/tenants/storage — SuperAdmin only. Reads the latest persisted
  // meter values so dashboard requests do not scan every MySQL database.
  static async getStorageOverview(req, res) {
    try {
      const { Tenant, TenantDatabase } = require("../models/masterDb");
      const { DEFAULT_DB_QUOTA_BYTES, DEFAULT_FILE_QUOTA_BYTES, formatStorage } = require("../services/tenantStorageService");
      const [tenants, rows] = await Promise.all([
        Tenant.findAll({ where: { status: "ACTIVE" }, attributes: ["id", "tenantName", "tenantCode", "tenantType"] }),
        TenantDatabase.findAll({ where: { status: "READY" } }),
      ]);
      const tenantMap = new Map(tenants.map((t) => [t.id, t.toJSON()]));
      const data = rows.map((row) => {
        const databaseQuotaBytes = Number(row.databaseQuotaBytes ?? DEFAULT_DB_QUOTA_BYTES);
        const fileQuotaBytes = Number(row.fileQuotaBytes ?? DEFAULT_FILE_QUOTA_BYTES);
        const databaseBytes = Number(row.databaseBytes || 0);
        const fileBytes = Number(row.fileBytes || 0);
        const totalBytes = Number(row.totalBytes || databaseBytes + fileBytes);
        return {
          tenantId: row.tenantId,
          tenant: tenantMap.get(row.tenantId) || null,
          status: row.status,
          databaseName: row.databaseName,
          databaseBytes,
          databaseDataBytes: Number(row.databaseDataBytes || 0),
          databaseIndexBytes: Number(row.databaseIndexBytes || 0),
          fileBytes,
          totalBytes,
          databaseQuotaBytes,
          fileQuotaBytes,
          totalQuotaBytes: databaseQuotaBytes + fileQuotaBytes,
          databaseUsagePercent: databaseQuotaBytes ? Number((databaseBytes / databaseQuotaBytes * 100).toFixed(2)) : 0,
          fileUsagePercent: fileQuotaBytes ? Number((fileBytes / fileQuotaBytes * 100).toFixed(2)) : 0,
          totalUsagePercent: databaseQuotaBytes + fileQuotaBytes ? Number((totalBytes / (databaseQuotaBytes + fileQuotaBytes) * 100).toFixed(2)) : 0,
          overDatabaseQuota: databaseBytes > databaseQuotaBytes,
          overFileQuota: fileBytes > fileQuotaBytes,
          overTotalQuota: totalBytes > databaseQuotaBytes + fileQuotaBytes,
          storageMeasuredAt: row.storageMeasuredAt,
          formatted: {
            database: formatStorage(databaseBytes), files: formatStorage(fileBytes), total: formatStorage(totalBytes),
            databaseQuota: formatStorage(databaseQuotaBytes), fileQuota: formatStorage(fileQuotaBytes), totalQuota: formatStorage(databaseQuotaBytes + fileQuotaBytes),
          },
        };
      }).filter((row) => row.tenant);
      const totals = data.reduce((acc, row) => {
        acc.databaseBytes += row.databaseBytes;
        acc.fileBytes += row.fileBytes;
        acc.totalBytes += row.totalBytes;
        acc.databaseQuotaBytes += row.databaseQuotaBytes;
        acc.fileQuotaBytes += row.fileQuotaBytes;
        return acc;
      }, { databaseBytes: 0, fileBytes: 0, totalBytes: 0, databaseQuotaBytes: 0, fileQuotaBytes: 0 });
      totals.totalQuotaBytes = totals.databaseQuotaBytes + totals.fileQuotaBytes;
      totals.formatted = {
        database: formatStorage(totals.databaseBytes), files: formatStorage(totals.fileBytes), total: formatStorage(totals.totalBytes), totalQuota: formatStorage(totals.totalQuotaBytes),
      };
      return res.json({ success: true, data, totals, cached: true });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // POST /api/tenants/storage/refresh — SuperAdmin only. Explicit live scan.
  static async refreshStorage(req, res) {
    try {
      const { measureAllTenantStorage } = require("../services/tenantStorageService");
      const data = await measureAllTenantStorage();
      return res.json({ success: true, message: "Tenant storage usage refreshed", data });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // GET /api/tenants/:id/storage — SuperAdmin only. Measures one tenant.
  static async getStorage(req, res) {
    try {
      const { measureTenantStorage } = require("../services/tenantStorageService");
      const data = await measureTenantStorage(Number(req.params.id));
      return res.json({ success: true, data });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // PUT /api/tenants/:id/storage/quota — SuperAdmin only. Changes quota,
  // never the physical MySQL database size. Quotas are byte values at the
  // API boundary to avoid unit ambiguity; the UI sends GB converted to bytes.
  static async updateStorageQuota(req, res) {
    try {
      const { assertQuotaValue, measureTenantStorage } = require("../services/tenantStorageService");
      const tenantDb = await TenantDatabase.findOne({ where: { tenantId: req.params.id } });
      if (!tenantDb) return res.status(404).json({ success: false, message: "Tenant database record not found" });

      const databaseQuotaBytes = assertQuotaValue(req.body.databaseQuotaBytes, "databaseQuotaBytes");
      const fileQuotaBytes = assertQuotaValue(req.body.fileQuotaBytes, "fileQuotaBytes");
      await tenantDb.update({ databaseQuotaBytes, fileQuotaBytes });
      const storage = await measureTenantStorage(Number(req.params.id));
      return res.json({ success: true, message: "Storage quotas updated", data: storage });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  // POST /api/tenants/:id/provision — SuperAdmin only.
  // For a Tenant row that exists in the Master DB but has never been
  // (successfully) provisioned — e.g. created some other way than the
  // self-registration flow, or whose very first provisioning attempt
  // never ran. Requires a TenantDatabase(status=PROVISIONING) row to
  // already exist; this endpoint does not create the Tenant itself
  // (registration is still the only way to do that — see brief section
  // 15: "only authorized system/SuperAdmin flow can provision", not
  // "SuperAdmin freely creates arbitrary tenants with no admin user").
  static async provision(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.id);
      if (!tenant) {
        return res
          .status(404)
          .json({ success: false, message: "Tenant Not Found" });
      }
      const tenantDb = await TenantDatabase.findOne({
        where: { tenantId: tenant.id },
      });
      if (!tenantDb) {
        return res.status(400).json({
          success: false,
          message:
            "No TenantDatabase record exists for this tenant. Provisioning must be initiated through registration, which creates it.",
        });
      }
      if (tenantDb.status === "READY") {
        return res
          .status(200)
          .json({
            success: true,
            message: "Tenant is already provisioned.",
            data: tenantDb,
          });
      }

      const { name, email, password, mobileNumber } = req.body;
      if (!name || !email || !password) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "name, email and password are required to create the tenant admin",
          });
      }

      const result = await provisionTenant(
        require("../models/masterDb"),
        tenant.id,
        { name, email, password, mobileNumber },
      );
      return res
        .status(200)
        .json({
          success: true,
          data: result.tenantDatabase,
          admin: result.admin,
        });
    } catch (error) {
      const isProvisioningError = error instanceof TenantProvisioningError;
      return res.status(isProvisioningError ? 502 : 500).json({
        success: false,
        message: error.message,
        step: isProvisioningError ? error.step : undefined,
      });
    }
  }

  // POST /api/tenants/:id/retry-provisioning — SuperAdmin only.
  // Same underlying call as /provision — provisionTenant() is already
  // idempotent/retry-safe (brief section 10) — kept as a separate,
  // clearly-named endpoint because "retry a failed provisioning" and
  // "provision a tenant for the first time" are different SuperAdmin
  // intents even though the code path is identical, and because the
  // brief explicitly asks for both endpoints to exist.
  static async retryProvisioning(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.id);
      if (!tenant) {
        return res
          .status(404)
          .json({ success: false, message: "Tenant Not Found" });
      }
      const tenantDb = await TenantDatabase.findOne({
        where: { tenantId: tenant.id },
      });
      if (!tenantDb) {
        return res
          .status(400)
          .json({
            success: false,
            message: "No TenantDatabase record exists for this tenant.",
          });
      }
      if (tenantDb.status !== "FAILED") {
        return res.status(400).json({
          success: false,
          message: `Only a FAILED provisioning can be retried (current status: ${tenantDb.status}).`,
        });
      }

      const { name, email, password, mobileNumber } = req.body;
      if (!name || !email || !password) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "name, email and password are required (re-supplied for the retry)",
          });
      }

      const result = await provisionTenant(
        require("../models/masterDb"),
        tenant.id,
        { name, email, password, mobileNumber },
      );
      return res
        .status(200)
        .json({
          success: true,
          data: result.tenantDatabase,
          admin: result.admin,
        });
    } catch (error) {
      const isProvisioningError = error instanceof TenantProvisioningError;
      return res.status(isProvisioningError ? 502 : 500).json({
        success: false,
        message: error.message,
        step: isProvisioningError ? error.step : undefined,
      });
    }
  }

  // PUT /api/tenants/:id — SuperAdmin only.
  // erpConfigId is no longer accepted here — ErpConfig is a per-tenant
  // model now (Phase 2), configured from inside the tenant itself, not
  // assigned by SuperAdmin at the master level.
  static async update(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.id);
      if (!tenant) {
        return res
          .status(404)
          .json({ success: false, message: "Tenant Not Found" });
      }

      const {
        tenantName,
        tenantCode,
        status,
        metadata,
        erpEnabled,
        erpConfigId,
        erpConfigIds,
      } = req.body;

      let nextErpEnabled = tenant.erpEnabled;
      let nextErpConfigId = tenant.erpConfigId;

      const hasMultiSelection = Array.isArray(erpConfigIds);
      const requestedErpIds = hasMultiSelection
        ? Array.from(new Set(erpConfigIds.map(Number).filter(Number.isInteger)))
        : (erpConfigId ? [Number(erpConfigId)] : null);

      const transaction = await masterSequelize.transaction();
      try {
        if (erpEnabled !== undefined) {
          const wantsErp = erpEnabled === true || erpEnabled === "true";
          if (wantsErp && (!requestedErpIds || requestedErpIds.length === 0)) {
            await transaction.rollback();
            return res.status(400).json({ success: false, message: "At least one ERP configuration is required when ERP is enabled" });
          }
          if (wantsErp) {
            const configs = await ErpConfig.findAll({ where: { id: requestedErpIds }, transaction });
            if (configs.length !== requestedErpIds.length) {
              await transaction.rollback();
              return res.status(404).json({ success: false, message: "One or more ERP configurations were not found" });
            }
          }
          nextErpEnabled = wantsErp;
          nextErpConfigId = wantsErp ? requestedErpIds[0] : null;
        }

        await tenant.update({
        ...(tenantName !== undefined ? { tenantName } : {}),
        ...(tenantCode !== undefined ? { tenantCode } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        erpEnabled: nextErpEnabled,
        erpConfigId: nextErpConfigId,
      }, { transaction });

      if (erpEnabled !== undefined || hasMultiSelection) {
        // PHASE 3 (multi-ERP sync management) — this destroy+recreate was
        // already here (Phase 1/2); preserve isDefault across it instead
        // of silently wiping every tenant's default back to none on the
        // next unrelated tenant edit that happens to resubmit erpConfigIds.
        const previousDefault = await TenantErpConnection.findOne({
          where: { tenantId: tenant.id, isDefault: true },
          transaction,
        });
        const previousDefaultErpConfigId = previousDefault?.erpConfigId ?? null;

        const ids = nextErpEnabled && requestedErpIds ? requestedErpIds : [];
        await TenantErpConnection.destroy({ where: { tenantId: tenant.id }, transaction });
        if (ids.length) {
          await TenantErpConnection.bulkCreate(
            ids.map((id) => ({ tenantId: tenant.id, erpConfigId: id, isActive: true, isDefault: false })),
            { transaction }
          );
          // Tenant-wide default: preserve the previous default when it is
          // still assigned; otherwise default the first assigned connection.
          // The default is ERP-type agnostic at the tenant-management level.
          const restoredDefaultId = ids.includes(previousDefaultErpConfigId)
            ? previousDefaultErpConfigId
            : ids[0];
          if (restoredDefaultId) {
            await TenantErpConnection.update(
              { isDefault: true },
              { where: { tenantId: tenant.id, erpConfigId: restoredDefaultId }, transaction },
            );
            // MULTI-ERP FIX: the legacy Tenant.erpConfigId (shown in the
            // Super Admin list/drawer and used as a fallback by older
            // code) used to be set to requestedErpIds[0] — the FIRST ticked
            // ERP — which is unrelated to the real default. Keep it equal
            // to the default connection so both always agree.
            await tenant.update({ erpConfigId: restoredDefaultId }, { transaction });
          }
        }
      }

      await transaction.commit();
      return res.json({ success: true, data: tenant });
      } catch (transactionError) {
        await transaction.rollback().catch(() => {});
        return res.status(500).json({ success: false, message: transactionError.message });
      }
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // DELETE /api/tenants/:id — SuperAdmin only. Soft-deactivate.
  //
  // Interim implementation — flips master Tenant.status to INACTIVE only.
  // Phase 7's Super Admin control plane will build the fuller lifecycle
  // action (also closing any live tenantConnectionManager connection for
  // this tenant and writing a PlatformAuditLog entry) — this is enough to
  // make the existing DELETE endpoint correct in the meantime: an
  // INACTIVE tenant is correctly refused at login by
  // tenantResolverMiddleware.js regardless of whether its connection gets
  // proactively closed here or just naturally idles out.
  // PUT /api/tenants/:id/erp-connections/:erpConfigId/default — SuperAdmin
  // only. PHASE 3 (multi-ERP sync management), PART 2 — makes exactly one
  // of a tenant's ACTIVE connections the default; unsets any previous
  // default transactionally so two connections are never both default.
  static async setDefaultErpConnection(req, res) {
    try {
      const tenantId = parseInt(req.params.id, 10);
      const erpConfigId = parseInt(req.params.erpConfigId, 10);
      if (!Number.isInteger(tenantId) || !Number.isInteger(erpConfigId)) {
        return res.status(400).json({ success: false, message: "Invalid tenant or ERP configuration id" });
      }

      const transaction = await masterSequelize.transaction();
      try {
        // Ownership check first — an inactive or unassigned connection
        // can never become default (PART 14: inactive ERPs are excluded
        // from default selection).
        const connection = await TenantErpConnection.findOne({
          where: { tenantId, erpConfigId, isActive: true },
          include: [{
            model: ErpConfig,
            as: "erpConfig",
            attributes: ["id", "erpType", "status"],
          }],
          transaction,
        });
        if (!connection) {
          await transaction.rollback();
          return res.status(404).json({
            success: false,
            message: "This ERP configuration is not an active connection for this tenant",
          });
        }

        if (!["ACTIVE", "CONNECTED"].includes(connection.erpConfig?.status)) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: "Only an active ERP connection can be set as the tenant default",
          });
        }

        await TenantErpConnection.update(
          { isDefault: false },
          { where: { tenantId, isDefault: true }, transaction },
        );
        await connection.update({ isDefault: true }, { transaction });

        // MULTI-ERP FIX: keep legacy Tenant.erpConfigId in sync with the
        // default, otherwise the tenant list/drawer keep showing the old
        // ERP after "Set Default".
        await Tenant.update(
          { erpConfigId },
          { where: { id: tenantId }, transaction },
        );

        await transaction.commit();
        return res.json({
          success: true,
          data: { tenantId, erpConfigId, isDefault: true },
        });
      } catch (transactionError) {
        await transaction.rollback().catch(() => {});
        return res.status(500).json({ success: false, message: transactionError.message });
      }
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async delete(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.id);

      if (!tenant) {
        return res
          .status(404)
          .json({ success: false, message: "Tenant Not Found" });
      }

      await tenant.update({ status: "INACTIVE", deactivatedAt: new Date() });

      return res.json({
        success: true,
        message: "Tenant deactivated successfully",
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = TenantController;