// src/models/tenantModels/TenantDepartmentPlant.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/TenantDepartmentPlant.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// ─────────────────────────────────────────────────────────────
// Tenant-specific Plant mapping for a Department.
//
// WHY THIS TABLE EXISTS
// Department is a GLOBAL MASTER (created once by SuperAdmin and shared
// across every tenant it is assigned to via TenantDepartment). Previously,
// "which Plant uses this Department" was stored as a single `plantId`
// column directly on the Department row. Because Department rows are
// shared, the LAST tenant to set that column silently overwrote it for
// every other tenant using the same Department — e.g. DEF Tenant mapping
// "Finance" -> Plant A made it impossible for XYZ Tenant to map
// "Finance" -> Plant B. Tenant-specific configuration was leaking into
// global master data.
//
// This table stores that mapping OUTSIDE both Department and
// TenantDepartment, scoped per tenant, so plant assignments never
// mutate global master data and never collide across tenants.
//
// One row = "for THIS tenant, THIS (already tenant-assigned) global
// Department is used at THIS Plant (under THIS Company Code)".
// ─────────────────────────────────────────────────────────────
module.exports = (sequelize) => sequelize.define(
  "TenantDepartmentPlant",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    // The Tenant<->Department assignment this mapping belongs to.
    // Guarantees we can never map a Plant to a Department the tenant
    // hasn't been granted access to.
    tenantDepartmentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    // Denormalized for fast tenant-scoped queries (same convention already
    // used by Category / DocumentType / Document / Plant / CompanyCode)
    // and as a belt-and-braces tenant isolation guard at the DB layer.
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    departmentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    plantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "plants", key: "id" },
    },
    // Denormalized from Plant.companyCodeId so "Company Code assignment"
    // is also available without an extra join, per requirements.
    companyCodeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "company_codes", key: "id" },
    },

    assignedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "userId who created this mapping",
    },

    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "tenant_department_plants",
    timestamps: true,
    indexes: [
      {
        // A given tenant may only map a given Department to a given Plant once.
        // Different tenants mapping the SAME Department to the SAME (or a
        // different) Plant is explicitly allowed — that's the whole point.
        unique: true,
        fields: ["tenantId", "departmentId", "plantId"],
        name: "unique_tenant_department_plant",
      },
      { fields: ["tenantId"] },
      { fields: ["plantId"] },
      { fields: ["departmentId"] },
      { fields: ["companyCodeId"] },
    ],
  }
);

