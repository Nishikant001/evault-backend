// src/models/masterDb/Department.js
//
// PHASE B — moved here, not to tenantModels/, because Department is
// documented in the legacy code itself as global master data:
//   "SuperAdmin manages Department master (no tenant FK on Department)"
//   (src/models/index.js, original line ~80)
// Department has no tenantId column, `name`/`code`/`sapCode` are unique
// ACROSS THE WHOLE SYSTEM (not per-tenant), and it's shared across every
// tenant that gets granted access to it via TenantDepartment. That's
// unambiguously platform-level reference data, the same tier as Plan.
//
// Field-for-field identical to legacy src/models/Department.js.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const Department = masterSequelize.define(
  "Department",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // DEPRECATED — legacy single global Plant link, no longer written to.
    // Plant now lives in the TENANT DB (Phase B), so this can no longer
    // even be a real FK the way it could in the old shared-DB world —
    // kept as a plain nullable integer purely for backward-compatible
    // reads of old data. See TenantDepartmentPlant for the real mechanism.
    plantId: { type: DataTypes.INTEGER, allowNull: true },

    name: { type: DataTypes.STRING, allowNull: false, unique: true },
    code: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: "Short unique code e.g. HR, FIN, OPS",
    },
    description: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
    },

    sapCode: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
      comment: "SAP DepartmentSet code — set by SAP Master Synchronization",
    },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "departments",
    timestamps: true,
  },
);

module.exports = Department;
