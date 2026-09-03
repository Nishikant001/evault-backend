const express =
require("express");

const router =
express.Router();

const authMiddleware =
require("../middleware/authMiddleware");

const roleMiddleware =
require("../middleware/roleMiddleware");
const { requireTenantModule } = require("../middleware/tenantModuleMiddleware");

const AuditController =
require("../controllers/auditController");

// Roles allowed to view the audit trail — unchanged from the original policy.
const AUDIT_VIEWER_ROLES = ["SuperAdmin", "TenantAdmin", "Auditor"];

/**
 * @swagger
 * tags:
 *   name: Audit
 *   description: Enterprise Audit Trail — view, filter, search and export system activity logs
 */

/**
 * @swagger
 * /api/audit-logs:
 *   get:
 *     summary: List audit log entries (paginated, filterable, searchable)
 *     tags: [Audit]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 25 }
 *       - in: query
 *         name: module
 *         schema: { type: string }
 *       - in: query
 *         name: action
 *         schema: { type: string }
 *       - in: query
 *         name: userId
 *         schema: { type: integer }
 *       - in: query
 *         name: department
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [SUCCESS, FAILED, PENDING] }
 *       - in: query
 *         name: documentId
 *         schema: { type: integer }
 *       - in: query
 *         name: sapDocumentId
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: tenantId
 *         description: SuperAdmin only — filter to a specific tenant
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Paginated list of audit log entries
 */
router.get(
  "/",
  authMiddleware,
  requireTenantModule("audit"),
  roleMiddleware(...AUDIT_VIEWER_ROLES),
  AuditController.getAll
);

/**
 * @swagger
 * /api/audit-logs/export:
 *   get:
 *     summary: Export audit log entries as CSV (accepts the same filters as GET /)
 *     tags: [Audit]
 *     responses:
 *       200:
 *         description: CSV file download
 */
router.get(
  "/export",
  authMiddleware,
  requireTenantModule("audit"),
  roleMiddleware(...AUDIT_VIEWER_ROLES),
  AuditController.exportCsv
);

/**
 * @swagger
 * /api/audit-logs/meta/filters:
 *   get:
 *     summary: Get distinct module/action/status values for building filter UIs
 *     tags: [Audit]
 *     responses:
 *       200:
 *         description: Distinct modules, actions and statuses
 */
router.get(
  "/meta/filters",
  authMiddleware,
  requireTenantModule("audit"),
  roleMiddleware(...AUDIT_VIEWER_ROLES),
  AuditController.getFilterMeta
);

/**
 * @swagger
 * /api/audit-logs/{id}:
 *   get:
 *     summary: Get a single audit log entry by ID
 *     tags: [Audit]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Audit log entry
 *       404:
 *         description: Not found
 */
router.get(
  "/:id",
  authMiddleware,
  requireTenantModule("audit"),
  roleMiddleware(...AUDIT_VIEWER_ROLES),
  AuditController.getById
);

module.exports =
router;
