// src/models/masterDb/TenantDepartment.js
//
// PHASE B — moved here alongside Department: this is the admin-controlled
// grant of "which global Departments can tenant X use" — a platform/
// entitlement decision (same tier as Subscription/PlanFeature), and it
// genuinely FKs to two tables that are BOTH now in the Master DB
// (tenants, departments). Keeping it here means that FK stays real and
// enforced instead of becoming a dangling cross-database reference.
//
// Field-for-field identical to legacy src/models/TenantDepartment.js.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const TenantDepartment = masterSequelize.define(
  "TenantDepartment",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.INTEGER, allowNull: false },
    departmentId: { type: DataTypes.INTEGER, allowNull: false },
    assignedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "userId of the Admin/SuperAdmin who made this assignment",
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "tenant_departments",
    timestamps: true,
    indexes: [{ unique: true, fields: ["tenantId", "departmentId"] }],
  },
);

module.exports = TenantDepartment;
