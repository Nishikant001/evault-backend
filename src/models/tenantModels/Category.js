// src/models/tenantModels/Category.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/Category.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "Category",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    departmentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "Must be a department assigned to this tenant",
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
    },

    // ── SAP Master Synchronization ─────────────────────────
    // The SAP CategorySet code this row was created/matched from. Category
    // is tenant-scoped (unlike the global Department master), so uniqueness
    // is scoped to (tenantId, sapCode) via the index below rather than
    // globally — two different tenants' SAP systems may legitimately reuse
    // the same category code.
    sapCode: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "SAP CategorySet code — set by SAP Master Synchronization",
    },
     erpConfigId: {                    // ← ADD
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    lastSyncedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "Last time this row was updated by SAP Master Synchronization",
    },
  },
  {
    tableName: "categories",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["tenantId", "departmentId", "name"],
        name: "unique_category_per_tenant_dept",
      },
      {
        unique: true,
        fields: ["tenantId", "sapCode"],
        name: "unique_category_sapcode_per_tenant",
      },
    ],
  }
);

