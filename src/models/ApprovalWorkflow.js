// src/models/ApprovalWorkflow.js
//
// A Tenant-configurable Approval Workflow, scoped to exactly one
// Department -> Category -> DocumentType combination.
//
// Approval is NOT mandatory for every document: the Approval Engine only
// runs for a document if an ACTIVE ApprovalWorkflow row exists for that
// document's (departmentId, categoryId, documentTypeId) combo. If no row
// exists (or it is INACTIVE), the existing no-approval upload -> SAP flow
// is completely unaffected.
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ApprovalWorkflow = sequelize.define(
  "ApprovalWorkflow",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "tenants", key: "id" },
    },
    departmentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "departments", key: "id" },
    },
    categoryId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "categories", key: "id" },
    },
    documentTypeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "document_types", key: "id" },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "Display name for the Approval Matrix Builder UI",
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // Reserved for future PARALLEL approval support; every level currently
    // runs SEQUENTIAL, but this flag lets the engine branch later without
    // a schema change.
    approvalMode: {
      type: DataTypes.ENUM("SEQUENTIAL", "PARALLEL"),
      allowNull: false,
      defaultValue: "SEQUENTIAL",
    },
    // Uploader cannot approve their own document unless a tenant admin
    // explicitly opts in for this workflow.
    allowSelfApproval: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      allowNull: false,
      defaultValue: "ACTIVE",
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
  },
  {
    tableName: "approval_workflows",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["tenantId", "departmentId", "categoryId", "documentTypeId"],
        name: "unique_workflow_per_tenant_combo",
      },
    ],
  }
);

module.exports = ApprovalWorkflow;
