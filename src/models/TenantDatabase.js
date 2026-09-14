const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// TenantDatabase — MASTER-side record of a tenant's provisioning /
// physical-database state.
//
// COMPATIBILITY NOTE (added while completing Phase 5):
// The Phase 5 reference conversion (tenantController.js / planController.js)
// was written against a true database-per-tenant architecture where this
// model lives in a separate MASTER database and tracks a REAL physical
// tenant database (name, provisioning status, live connection info).
// That architecture (Phase 1-4/6: master/tenant DB split, tenant
// connection manager, tenant model factory, automated CREATE DATABASE
// provisioning) does not exist anywhere in this codebase — everything
// (Tenant, User, Document, Plan, Subscription, etc.) still lives in ONE
// shared database via the single `src/config/database.js` connection.
//
// This model is added now purely so the already-converted Phase 5 files
// that `require("../models/master")` and reference `TenantDatabase` do
// not crash on startup. It is a real table in the SAME shared database,
// not a record of a separate physical tenant database. `status` will be
// set to "READY" for every tenant at creation time (see migration) since
// there is no real provisioning pipeline yet to report a different state.
//
// Genuine per-tenant database provisioning/isolation is a separate,
// substantial project (the real Phase 1-4/6 work) and is NOT implemented
// by this shim. See the final report for details.
const TenantDatabase = sequelize.define(
  "TenantDatabase",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    databaseName: { type: DataTypes.STRING, allowNull: true },
    status: {
      type: DataTypes.ENUM("PROVISIONING", "READY", "FAILED"),
      allowNull: false,
      defaultValue: "READY",
    },
    provisionedAt: { type: DataTypes.DATE, allowNull: true },
    documentCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    userCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    databaseDataBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    databaseIndexBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    databaseBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    fileBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    totalBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    databaseQuotaBytes: { type: DataTypes.BIGINT, allowNull: true },
    fileQuotaBytes: { type: DataTypes.BIGINT, allowNull: true },
    storageMeasuredAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "tenant_databases",
    timestamps: true,
  },
);

module.exports = TenantDatabase;
