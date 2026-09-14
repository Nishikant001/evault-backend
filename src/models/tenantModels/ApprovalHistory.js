// src/models/tenantModels/ApprovalHistory.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/ApprovalHistory.js — only
// the require/export wrapper differs.
// src/models/ApprovalHistory.js
//
// Immutable, append-only ledger of every action taken against a
// DocumentApproval. Nothing here is ever updated or deleted — this is
// the enterprise audit trail specific to the approval chain (separate
// from, but complementary to, the generic AuditLog table).
const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "ApprovalHistory",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    documentApprovalId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "document_approvals", key: "id" },
    },
    documentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "documents", key: "id" },
      comment: "Denormalized for fast timeline lookups by document",
    },
    levelNumber: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Level this action applied to (null for workflow-level actions like CANCEL)",
    },
    action: {
      type: DataTypes.ENUM(
        "SUBMIT",
        "APPROVE",
        "REJECT",
        "SEND_BACK",
        "CANCEL",
        "RESUBMIT",
        "SKIP",
        "DELEGATE"
      ),
      allowNull: false,
    },
    actionBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    actionByName: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Snapshot of actor's name at the time of the action",
    },
    actionByRole: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Snapshot of actor's role at the time of the action",
    },
    oldStatus: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    newStatus: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    comments: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    rejectReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ipAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    tableName: "approval_history",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["documentApprovalId"] },
      { fields: ["documentId"] },
      { fields: ["action"] },
    ],
  }
);

