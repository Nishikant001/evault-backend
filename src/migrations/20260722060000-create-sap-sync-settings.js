"use strict";

// One row per tenant — configurable knobs for the SAP Sync module's
// Settings page. Auto-provisioned with sane defaults on first read
// (see sapSyncSettingsService.getOrCreate).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("sap_sync_settings", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: "tenants", key: "id" },
        onDelete: "CASCADE",
      },
      autoSyncEnabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      retryCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 5 },
      batchSize: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 50 },
      parallelJobs: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      importOnlyHasOriginal: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      pendingClassificationRule: {
        type: Sequelize.ENUM("HOLD_FOR_MANUAL", "AUTO_ASSIGN_DEFAULT", "SKIP"),
        allowNull: false,
        defaultValue: "HOLD_FOR_MANUAL",
      },
      duplicateStrategy: {
        type: Sequelize.ENUM("SKIP", "OVERWRITE", "VERSION"),
        allowNull: false,
        defaultValue: "SKIP",
      },
      syncIntervalMinutes: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1440 },
      updatedBy: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable("sap_sync_settings");
  },
};
