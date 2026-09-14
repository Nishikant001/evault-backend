// src/models/tenantModels/SapSyncLog.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/SapSyncLog.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// One row per synchronization RUN (a "run" = one call to syncMasters(),
// syncDocuments(), or the retry processor). Gives the REST APIs
// (GET /api/sap-sync/logs, GET /api/sap-sync/status) a full audit trail of
// start/end time, duration, record counts, and errors, independent of the
// generic AuditLog table (which stays focused on user-facing actions).
module.exports = (sequelize) => sequelize.define(
  "SapSyncLog",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "Tenant whose ErpConfig drove this sync run",
    },
    erpConfigId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    syncType: {
      type: DataTypes.ENUM("MASTER", "DOCUMENT"),
      allowNull: false,
    },
    triggerType: {
      type: DataTypes.ENUM("MANUAL", "SCHEDULED", "RETRY"),
      allowNull: false,
      defaultValue: "MANUAL",
    },
    status: {
      type: DataTypes.ENUM("RUNNING", "SUCCESS", "PARTIAL_SUCCESS", "FAILED"),
      allowNull: false,
      defaultValue: "RUNNING",
    },
    startTime: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    endTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    durationMs: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    recordsFetched: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    recordsCreated: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    recordsUpdated: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    recordsSkipped: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    recordsFailed: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    recordsPendingClassification: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    // Per-entity breakdown for MASTER runs, e.g.
    // { DEPARTMENT: { fetched, created, updated, failed }, CATEGORY: {...}, DOCUMENT_TYPE: {...} }
    summary: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    // Array of { entityType, code, message, timestamp }
    errors: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: [],
    },
    triggeredBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
      comment: "Null for SCHEDULED/RETRY runs triggered by the cron scheduler",
    },
  },
  {
    tableName: "sap_sync_logs",
    timestamps: true,
    indexes: [
      { fields: ["tenantId", "syncType", "createdAt"] },
      { fields: ["status"] },
    ],
  }
);

