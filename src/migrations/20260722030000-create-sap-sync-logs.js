"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("sap_sync_logs", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      erpConfigId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "erp_configs", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      syncType: { type: Sequelize.ENUM("MASTER", "DOCUMENT"), allowNull: false },
      triggerType: {
        type: Sequelize.ENUM("MANUAL", "SCHEDULED", "RETRY"),
        allowNull: false,
        defaultValue: "MANUAL",
      },
      status: {
        type: Sequelize.ENUM("RUNNING", "SUCCESS", "PARTIAL_SUCCESS", "FAILED"),
        allowNull: false,
        defaultValue: "RUNNING",
      },
      startTime: { type: Sequelize.DATE, allowNull: false },
      endTime: { type: Sequelize.DATE, allowNull: true },
      durationMs: { type: Sequelize.INTEGER, allowNull: true },
      recordsFetched: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      recordsCreated: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      recordsUpdated: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      recordsSkipped: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      recordsFailed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      recordsPendingClassification: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      summary: { type: Sequelize.JSON, allowNull: true },
      errors: { type: Sequelize.JSON, allowNull: true },
      triggeredBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("sap_sync_logs", ["tenantId", "syncType", "createdAt"]);
    await queryInterface.addIndex("sap_sync_logs", ["status"]);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("sap_sync_logs");
  },
};
