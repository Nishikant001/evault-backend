// src/models/DocumentApproval.js
//
// One row per document that has entered an approval chain. Tracks the
// live state of the run (current level, overall status). The immutable
// audit trail of every transition lives in ApprovalHistory — this table
// is the "current state" projection, ApprovalHistory is the ledger.
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DocumentApproval = sequelize.define(
  "DocumentApproval",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    documentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: "documents", key: "id" },
      comment: "One active approval run per document",
    },
    approvalWorkflowId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "approval_workflows", key: "id" },
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "tenants", key: "id" },
    },
    currentLevel: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    totalLevels: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(
        "SUBMITTED",
        "PENDING_APPROVAL",
        "PARTIALLY_APPROVED",
        "APPROVED",
        "REJECTED",
        "SENT_BACK",
        "CANCELLED",
        "COMPLETED"
      ),
      allowNull: false,
      defaultValue: "SUBMITTED",
    },
    submittedBy: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
    },
    submittedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    rejectedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    rejectedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    rejectReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "document_approvals",
    timestamps: true,
    indexes: [
      { fields: ["tenantId"] },
      { fields: ["status"] },
      { fields: ["approvalWorkflowId"] },
    ],
  }
);

module.exports = DocumentApproval;
