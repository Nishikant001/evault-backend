"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("sap_sync_retry_queue", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      entityType: {
        type: Sequelize.ENUM("DEPARTMENT", "CATEGORY", "DOCUMENT_TYPE", "DOCUMENT"),
        allowNull: false,
      },
      referenceCode: { type: Sequelize.STRING, allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      status: {
        type: Sequelize.ENUM("PENDING", "RETRYING", "RESOLVED", "ABANDONED"),
        allowNull: false,
        defaultValue: "PENDING",
      },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      maxAttempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 5 },
      lastError: { type: Sequelize.TEXT, allowNull: true },
      nextRetryAt: { type: Sequelize.DATE, allowNull: true },
      resolvedAt: { type: Sequelize.DATE, allowNull: true },
      history: { type: Sequelize.JSON, allowNull: false },
      sapSyncLogId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "sap_sync_logs", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("sap_sync_retry_queue", ["tenantId", "entityType", "referenceCode"], {
      unique: true,
      name: "unique_retry_item_per_tenant",
    });
    await queryInterface.addIndex("sap_sync_retry_queue", ["status", "nextRetryAt"]);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("sap_sync_retry_queue");
  },
};
