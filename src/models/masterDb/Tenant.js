// src/models/masterDb/Tenant.js
//
// PHASE A — real Master DB model, bound to masterSequelize (its own
// physical database), NOT the shared src/config/database.js connection.
//
// Field-for-field identical to the legacy src/models/Tenant.js — this is
// a genuine platform-level entity (the registry of every tenant, their
// status, and their plan/type), which is exactly what a Master DB is for.
//
// NOTE ON ASSOCIATIONS: the legacy src/models/index.js gives Tenant 20+
// hasMany/hasOne associations into models that are tenant-operational
// data (User, Document, Category, ApprovalWorkflow, AIProvider, ...).
// Those associations are NOT reproduced here. Once those models live in
// per-tenant physical databases (Phase B/C), they are on a DIFFERENT
// Sequelize connection than this Tenant model — Sequelize associations
// (and `include`-based eager loading) only work within a single
// connection, so a real cross-database "Tenant.hasMany(Document)" is not
// possible here. Code that currently relies on that kind of eager load
// will need a two-step lookup instead (Master DB for the Tenant row,
// then a separate query against that tenant's own connection) — that
// rewire happens in Phase E, not here.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const Tenant = masterSequelize.define(
  "Tenant",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    tenantName: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    tenantCode: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
    },
    erpConfigId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    erpEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      allowNull: false,
      defaultValue: "ACTIVE",
    },

    // ── Subscription Management System ──────────────────────────────
    tenantType: {
      type: DataTypes.ENUM("FREE", "PAID"),
      allowNull: false,
      defaultValue: "PAID",
    },

    // ── Frontend metadata-driven terminology/hierarchy ──────────────
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },

  {
    tableName: "tenants",
    timestamps: true,
  },
);

module.exports = Tenant;
