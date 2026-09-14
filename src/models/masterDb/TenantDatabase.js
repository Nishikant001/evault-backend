// src/models/masterDb/TenantDatabase.js
//
// PHASE A — this is the REAL version of this model. Unlike
// src/models/TenantDatabase.js (the Phase 5 compatibility shim, which
// lives in the shared DB and is hardcoded to status "READY" for every
// tenant because there was no real provisioning pipeline behind it),
// this copy lives in the Master DB and is meant to be driven by an
// actual provisioning pipeline: status starts at "PROVISIONING", a real
// `databaseName` is assigned, `CREATE DATABASE` is run, tenant migrations
// are run against it, and only then does status become "READY" (or
// "FAILED" if provisioning errors out). That pipeline is Phase D, not
// this file — this is just the model + table.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const TenantDatabase = masterSequelize.define(
  "TenantDatabase",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    databaseName: { type: DataTypes.STRING, allowNull: true },
    status: {
      type: DataTypes.ENUM("PROVISIONING", "READY", "FAILED"),
      allowNull: false,
      defaultValue: "PROVISIONING",
    },
    provisionedAt: { type: DataTypes.DATE, allowNull: true },
    documentCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    userCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // Storage metering/quota. Values are bytes. Null quota means the
    // platform default from tenantStorageService is used.
    databaseDataBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    databaseIndexBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    databaseBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    fileBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    totalBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    databaseQuotaBytes: { type: DataTypes.BIGINT, allowNull: true },
    fileQuotaBytes: { type: DataTypes.BIGINT, allowNull: true },
    storageMeasuredAt: { type: DataTypes.DATE, allowNull: true },

    // ── PHASE D — provisioning failure/retry tracking (additive) ──────
    provisioningAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failedStep: { type: DataTypes.STRING, allowNull: true },
    lastErrorCode: { type: DataTypes.STRING, allowNull: true },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    failedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "tenant_databases",
    timestamps: true,
  },
);

module.exports = TenantDatabase;
