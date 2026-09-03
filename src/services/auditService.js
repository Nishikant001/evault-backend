// src/services/auditService.js
//
// Central write/read layer for the Enterprise Audit Trail System.
//
// IMPORTANT — backward compatibility:
// AuditService.log(...) is already called from authController.js with the
// original signature: { userId, tenantId, action, module, details, ipAddress }.
// That exact call shape continues to work unchanged. Everything below is
// purely ADDITIVE — new optional fields, and new optional `req` support
// so callers can pass the Express request object once and get
// ip/browser/device/OS/actor-identity captured automatically.
//
// Phase 5: AuditLog is now a TENANT model (Phase 2) — every call needs a
// `models` set to know WHICH tenant database to write into. Exactly like
// ip/device/actor identity, this is derived automatically from `req.models`
// when a request object is passed (the common case — every controller has
// one). For callers with no `req` (cron jobs, Phase 6 registration, etc.),
// pass `models` explicitly instead. If neither is available, log() logs a
// console warning and skips the write — it NEVER falls back to the old
// shared connection, which would silently write the audit entry to the
// wrong tenant's history.

const { Op } = require("sequelize");
const { parseUserAgent, resolveIpAddress } = require("../utils/deviceParser");
const { AUDIT_STATUS } = require("../constants/auditActions");

class AuditService {
  /**
   * Write a single audit entry. NEVER throws — audit logging must not
   * break the caller's business flow, so any failure here is caught and
   * only logged to the console (mirrors the existing auditMiddleware.js
   * fail-safe pattern).
   *
   * @param {object} params
   * @param {import('express').Request} [params.req] - optional Express request; when
   *        provided, ipAddress/browser/device/operatingSystem and (if not
   *        explicitly given) userId/role/tenantId/username are derived from it.
   * @param {number}  [params.userId]
   * @param {string}  [params.username]
   * @param {string}  [params.role]
   * @param {string}  [params.department]
   * @param {string}  params.action     - one of AUDIT_ACTIONS (or free text, kept flexible)
   * @param {string}  params.module     - one of AUDIT_MODULES (or free text, kept flexible)
   * @param {*}       [params.oldValue] - object/array/primitive; stored as JSON
   * @param {*}       [params.newValue] - object/array/primitive; stored as JSON
   * @param {number}  [params.documentId]
   * @param {string}  [params.sapDocumentId]
   * @param {string}  [params.ipAddress]
   * @param {string}  [params.browser]
   * @param {string}  [params.device]
   * @param {string}  [params.operatingSystem]
   * @param {string}  [params.remarks]
   * @param {string}  [params.details]  - legacy field name, kept for old callers
   * @param {string}  [params.status]   - SUCCESS | FAILED | PENDING (default SUCCESS)
   * @param {number}  [params.tenantId]
   */
  static async log(params = {}) {
    try {
      const { req } = params;

      // ── Resolve which tenant database to write into ────────────────
      const models = params.models ?? req?.models;
      if (!models) {
        console.log(
          "Audit Error: no `models` provided and no `req.models` available " +
            "— skipping write rather than guessing a tenant database."
        );
        return;
      }
      const { AuditLog, User } = models;

      // ── Derive client context from the request, when available ──
      let derivedIp;
      let derivedDevice = {};
      if (req) {
        derivedIp = resolveIpAddress(req);
        derivedDevice = parseUserAgent(req.headers?.["user-agent"]);
      }

      // ── Derive actor identity from req.user (set by authMiddleware) ──
      const reqUser = req?.user || {};

      let userId = params.userId ?? reqUser.id ?? null;
      let role = params.role ?? reqUser.role ?? null;
      const tenantId = params.tenantId ?? reqUser.tenantId ?? null;
      let username = params.username;

      // If we still don't have a username, try a best-effort DB lookup.
      // This never blocks/breaks the caller — any failure is swallowed.
      if (!username && userId) {
        try {
          const user = await User.findByPk(userId, {
            attributes: ["name", "email"],
          });
          if (user) {
            username = user.name || user.email;
          }
        } catch (lookupError) {
          // Ignore — audit logging must remain best-effort.
        }
      }
      if (!username && reqUser.email) {
        username = reqUser.email;
      }

      const remarks = params.remarks ?? params.details ?? null;

      await AuditLog.create({
        // legacy columns
        userId,
        tenantId,
        action: params.action,
        module: params.module,
        details: params.details ?? remarks ?? null,
        ipAddress: params.ipAddress ?? derivedIp ?? null,

        // new columns
        username: username || null,
        role: role || null,
        department: params.department || null,
        oldValue: params.oldValue ?? null,
        newValue: params.newValue ?? null,
        documentId: params.documentId ?? null,
        sapDocumentId: params.sapDocumentId ?? null,
        browser: params.browser ?? derivedDevice.browser ?? null,
        device: params.device ?? derivedDevice.device ?? null,
        operatingSystem:
          params.operatingSystem ?? derivedDevice.operatingSystem ?? null,
        remarks,
        status: params.status || AUDIT_STATUS.SUCCESS,
      });
    } catch (error) {
      // Audit logging must never break the calling request/flow.
      console.log("Audit Error:", error.message);
    }
  }

  /**
   * List audit logs with pagination, filtering, search and date range.
   * Used by AuditController.getAll.
   *
   * @param {object} options
   * @param {number}  [options.tenantId]      - restrict to a tenant (omit for SuperAdmin "all tenants" view)
   * @param {number}  [options.page=1]
   * @param {number}  [options.limit=25]
   * @param {string}  [options.module]
   * @param {string}  [options.action]
   * @param {number}  [options.userId]
   * @param {string}  [options.department]
   * @param {string}  [options.status]
   * @param {number}  [options.documentId]
   * @param {string}  [options.sapDocumentId]
   * @param {string}  [options.search]        - matches username/action/module/remarks
   * @param {string}  [options.dateFrom]      - ISO date, inclusive
   * @param {string}  [options.dateTo]        - ISO date, inclusive
   * @param {string}  [options.sortBy="createdAt"]
   * @param {string}  [options.sortOrder="DESC"]
   */
  static async list(options = {}) {
    const {
      models,
      tenantId,
      page = 1,
      limit = 25,
      module,
      action,
      userId,
      department,
      status,
      documentId,
      sapDocumentId,
      search,
      dateFrom,
      dateTo,
      sortBy = "createdAt",
      sortOrder = "DESC",
    } = options;

    if (!models) {
      throw new Error("AuditService.list requires `models` (the tenant-scoped model set) in options");
    }
    const { AuditLog } = models;

    const where = {};
    if (tenantId !== undefined && tenantId !== null) where.tenantId = tenantId;
    if (module) where.module = module;
    if (action) where.action = action;
    if (userId) where.userId = userId;
    if (department) where.department = department;
    if (status) where.status = status;
    if (documentId) where.documentId = documentId;
    if (sapDocumentId) where.sapDocumentId = sapDocumentId;

    // ── Date range filtering (inclusive) ──────────────────────
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt[Op.gte] = new Date(dateFrom);
      if (dateTo) {
        // Include the entire "dateTo" day when only a date (no time) is given
        const end = new Date(dateTo);
        if (!dateTo.includes("T")) end.setHours(23, 59, 59, 999);
        where.createdAt[Op.lte] = end;
      }
    }

    // ── Free-text search across the most useful fields ────────
    if (search) {
      where[Op.or] = [
        { username: { [Op.like]: `%${search}%` } },
        { action: { [Op.like]: `%${search}%` } },
        { module: { [Op.like]: `%${search}%` } },
        { remarks: { [Op.like]: `%${search}%` } },
        { sapDocumentId: { [Op.like]: `%${search}%` } },
      ];
    }

    // Guard rails on pagination inputs
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
    const offset = (safePage - 1) * safeLimit;

    // Whitelist sortable columns to avoid SQL injection via sort params
    const sortableColumns = [
      "createdAt",
      "action",
      "module",
      "status",
      "username",
    ];
    const safeSortBy = sortableColumns.includes(sortBy) ? sortBy : "createdAt";
    const safeSortOrder = sortOrder === "ASC" ? "ASC" : "DESC";

    const { rows, count } = await AuditLog.findAndCountAll({
      where,
      order: [[safeSortBy, safeSortOrder]],
      limit: safeLimit,
      offset,
    });

    return {
      data: rows,
      pagination: {
        total: count,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(count / safeLimit) || 1,
      },
    };
  }

  /**
   * Fetch every row matching the given filters (no pagination) — used
   * for CSV export. Reuses the same filter logic as list() by simply
   * requesting a very high limit; capped to avoid runaway exports.
   */
  static async listForExport(options = {}) {
    const { data } = await AuditService.list({
      ...options,
      page: 1,
      limit: 10000,
    });
    return data;
  }

  static async getById(id, tenantId, models) {
    if (!models) {
      throw new Error("AuditService.getById requires `models` (the tenant-scoped model set)");
    }
    const { AuditLog } = models;
    const where = { id };
    if (tenantId !== undefined && tenantId !== null) where.tenantId = tenantId;
    return AuditLog.findOne({ where });
  }
}

module.exports = AuditService;
