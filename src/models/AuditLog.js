const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// ─────────────────────────────────────────────────────────────
// AuditLog — Enterprise Audit Trail
//
// Existing columns (id, action, module, userId, details, tenantId,
// ipAddress) are UNTOUCHED so every existing call site
// (authController.js, auditMiddleware.js, auditService.js) keeps working
// exactly as before.
//
// New columns below extend the model to capture the full audit context
// requested for the enterprise audit trail: actor identity snapshot,
// before/after values, linked document/SAP references, and client
// device fingerprint (browser / device / OS), plus a status flag so
// failed actions can be audited too.
//
// Actor identity fields (username/role/department) are intentionally
// stored as a point-in-time SNAPSHOT (denormalized) rather than only via
// the userId FK — this is standard audit-trail practice, because a
// user's name/role/department can change or the user can later be
// deleted, but the audit record must still show who did what, with
// which role, at the time the action happened.
// ─────────────────────────────────────────────────────────────
const AuditLog = sequelize.define(
  "AuditLog",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },

    action: {
      type: DataTypes.STRING,
      allowNull: false
    },

    module: {
      type: DataTypes.STRING,
      allowNull: false
    },

    userId: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    details: {
      type: DataTypes.TEXT
    },

    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: true
    },

    ipAddress: {
      type: DataTypes.STRING
    },

    // ── NEW: actor identity snapshot ───────────────────────
    username: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Snapshot of the acting user's name/email at the time of the action"
    },
    role: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Snapshot of the acting user's role at the time of the action"
    },
    department: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Department name relevant to the action (contextual, not necessarily the actor's own department)"
    },

    // ── NEW: change tracking ────────────────────────────────
    oldValue: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "State before the change (for CREATE/UPDATE/DELETE/APPROVAL events)"
    },
    newValue: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "State after the change (for CREATE/UPDATE/DELETE/APPROVAL events)"
    },

    // ── NEW: linked entities ────────────────────────────────
    documentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Internal Document.id this audit entry relates to, if any"
    },
    sapDocumentId: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "SAP DocumentId this audit entry relates to, if any"
    },

    // ── NEW: client fingerprint ─────────────────────────────
    browser: {
      type: DataTypes.STRING,
      allowNull: true
    },
    device: {
      type: DataTypes.STRING,
      allowNull: true
    },
    operatingSystem: {
      type: DataTypes.STRING,
      allowNull: true
    },

    // ── NEW: outcome ─────────────────────────────────────────
    remarks: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Free-text notes about the action (mirrors legacy `details` for readability)"
    },
    status: {
      type: DataTypes.ENUM("SUCCESS", "FAILED", "PENDING"),
      allowNull: false,
      defaultValue: "SUCCESS"
    }
  },
  {
    tableName: "audit_logs",
    timestamps: true,
    indexes: [
      { fields: ["tenantId"] },
      { fields: ["userId"] },
      { fields: ["module"] },
      { fields: ["action"] },
      { fields: ["documentId"] },
      { fields: ["status"] },
      { fields: ["createdAt"] }
    ]
  }
);

module.exports = AuditLog;