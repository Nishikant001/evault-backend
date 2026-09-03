// src/models/tenantModels/SapSyncSettings.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/SapSyncSettings.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// One row per tenant — knobs shown on the SAP Sync Settings page.
module.exports = (sequelize) => sequelize.define(
  "SapSyncSettings",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
    },
    autoSyncEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    retryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
    batchSize: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 50 },
    parallelJobs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    importOnlyHasOriginal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    pendingClassificationRule: {
      type: DataTypes.ENUM("HOLD_FOR_MANUAL", "AUTO_ASSIGN_DEFAULT", "SKIP"),
      allowNull: false,
      defaultValue: "HOLD_FOR_MANUAL",
    },
    duplicateStrategy: {
      type: DataTypes.ENUM("SKIP", "OVERWRITE", "VERSION"),
      allowNull: false,
      defaultValue: "SKIP",
    },
    syncIntervalMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1440 },
    updatedBy: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: "sap_sync_settings",
    timestamps: true,
  }
);

