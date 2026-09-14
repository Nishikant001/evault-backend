const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// One row per tenant — knobs shown on the SAP Sync Settings page.
const SapSyncSettings = sequelize.define(
  "SapSyncSettings",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: "tenants", key: "id" },
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

module.exports = SapSyncSettings;
