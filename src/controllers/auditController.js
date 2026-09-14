// src/controllers/auditController.js
//
// Enterprise Audit Trail — read APIs.
// Access is restricted (see auditRoutes.js) to SuperAdmin / TenantAdmin /
// Auditor, matching the existing role policy already used on GET /api/audit-logs.
//
// Tenant scoping rule (kept identical to the original controller, ONE
// exception noted below):
//   - Every non-SuperAdmin caller is always scoped to req.user.tenantId,
//     read through req.models (Phase 5 — AuditLog is a per-tenant model now).
//   - SuperAdmin may pass ?tenantId= to inspect a SPECIFIC tenant's trail —
//     unsupported for now (see NOT_IMPLEMENTED below), since that means
//     connecting to a tenant OTHER than the one req.models already points
//     to. Needs Phase 7's cross-tenant tooling (SuperAdmin routes will get
//     their own explicit tenant-connection resolution, not reuse req.models
//     which is scoped to the calling SuperAdmin's own JWT tenantId — SuperAdmin
//     doesn't have one, see authMiddleware.js's SuperAdmin bridge).
//   - SuperAdmin omitting ?tenantId= (audit trail across ALL tenants) is
//     the same problem at a bigger scale — would mean iterating every
//     tenant's database. Also deferred to Phase 7.

const AuditService = require("../services/auditService");

class AuditController {
  // GET /api/audit-logs
  // Supports pagination, filtering, search and date-range filtering.
  // Query params:
  //   page, limit, module, action, userId, department, status,
  //   documentId, sapDocumentId, search, dateFrom, dateTo, sortBy, sortOrder
  static async getAll(req, res) {
    try {
      if (req.user.role === "SuperAdmin") {
        return res.status(501).json({
          success: false,
          message: "Cross-tenant audit trail viewing is not yet available for SuperAdmin — coming in the Super Admin control plane phase.",
        });
      }

      const { page, limit, module, action, userId, department, status,
        documentId, sapDocumentId, search, dateFrom, dateTo, sortBy, sortOrder,
      } = req.query;

      const result = await AuditService.list({
        models: req.models,
        tenantId: req.user.tenantId,
        page,
        limit,
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
        sortBy,
        sortOrder,
      });

      return res.json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }

  // GET /api/audit-logs/:id
  static async getById(req, res) {
    try {
      if (req.user.role === "SuperAdmin") {
        return res.status(501).json({
          success: false,
          message: "Cross-tenant audit trail viewing is not yet available for SuperAdmin — coming in the Super Admin control plane phase.",
        });
      }

      const log = await AuditService.getById(req.params.id, req.user.tenantId, req.models);

      if (!log) {
        return res.status(404).json({
          success: false,
          message: "Audit log entry not found",
        });
      }

      return res.json({ success: true, data: log });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }

  // GET /api/audit-logs/export
  // Export-ready endpoint — streams matching audit entries as CSV.
  // Accepts the same filters as getAll (page/limit are ignored; capped at 10k rows).
  static async exportCsv(req, res) {
    try {
      if (req.user.role === "SuperAdmin") {
        return res.status(501).json({
          success: false,
          message: "Cross-tenant audit trail export is not yet available for SuperAdmin — coming in the Super Admin control plane phase.",
        });
      }

      const { module, action, userId, department, status,
        documentId, sapDocumentId, search, dateFrom, dateTo,
      } = req.query;

      const rows = await AuditService.listForExport({
        models: req.models,
        tenantId: req.user.tenantId,
        module, action, userId, department, status,
        documentId, sapDocumentId, search, dateFrom, dateTo,
      });

      const columns = [
        "id", "userId", "username", "role", "department", "module", "action",
        "documentId", "sapDocumentId", "ipAddress", "browser", "device",
        "operatingSystem", "status", "remarks", "createdAt",
      ];

      const escapeCsv = (value) => {
        if (value === null || value === undefined) return "";
        const str = typeof value === "object" ? JSON.stringify(value) : String(value);
        // Quote any field containing comma, quote or newline
        if (/[",\n]/.test(str)) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const header = columns.join(",");
      const lines = rows.map((row) =>
        columns.map((col) => escapeCsv(row[col])).join(",")
      );
      const csv = [header, ...lines].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="audit-logs-${Date.now()}.csv"`
      );
      return res.status(200).send(csv);
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }

  // GET /api/audit-logs/meta/filters
  // Returns the distinct list of modules/actions/statuses currently present
  // in the trail — handy for populating filter dropdowns in the UI.
  static async getFilterMeta(req, res) {
    try {
      if (req.user.role === "SuperAdmin") {
        return res.status(501).json({
          success: false,
          message: "Cross-tenant audit filter metadata is not yet available for SuperAdmin — coming in the Super Admin control plane phase.",
        });
      }

      const { AuditLog } = req.models;
      const where = { tenantId: req.user.tenantId };

      const [modules, actions] = await Promise.all([
        AuditLog.findAll({ where, attributes: ["module"], group: ["module"], raw: true }),
        AuditLog.findAll({ where, attributes: ["action"], group: ["action"], raw: true }),
      ]);

      return res.json({
        success: true,
        data: {
          modules: modules.map((m) => m.module).filter(Boolean),
          actions: actions.map((a) => a.action).filter(Boolean),
          statuses: ["SUCCESS", "FAILED", "PENDING"],
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
}

module.exports = AuditController;
