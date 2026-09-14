// src/models/tenantModels/ApprovalAssignment.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/ApprovalAssignment.js — only
// the require/export wrapper differs.
// src/models/ApprovalAssignment.js
//
// Defines WHO is eligible to act on a given ApprovalLevel. A level can
// have more than one assignment row (e.g. "DeptHead role" OR two named
// backup users) — any single matching assignment is sufficient for a
// user to be treated as the approver for that level.
const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "ApprovalAssignment",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    approvalLevelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "approval_levels", key: "id" },
    },
    // ROLE / DESIGNATION are resolved against User.role (the schema has no
    // separate designation field today, so DESIGNATION is treated as an
    // alias of ROLE — see production notes). DEPARTMENT is resolved
    // against User.role scoped to this tenant, using approverDepartmentId
    // for reporting/context only, since Users are not currently mapped
    // 1:1 to a Department in this schema.
    approverType: {
      type: DataTypes.ENUM("ROLE", "USER", "DESIGNATION", "DEPARTMENT"),
      allowNull: false,
    },
    approverRole: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Used when approverType is ROLE / DESIGNATION / DEPARTMENT",
    },
    approverUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
      comment: "Used when approverType is USER",
    },
    approverDepartmentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Used when approverType is DEPARTMENT (contextual scope)",
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      allowNull: false,
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "approval_assignments",
    timestamps: true,
  }
);

