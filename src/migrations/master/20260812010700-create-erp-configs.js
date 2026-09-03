"use strict";

// MASTER DB migration. No pre-existing "create" migration exists for
// erp_configs anywhere in the repo (built via sequelize.sync at boot,
// same situation as tenants/departments) — written from the current
// src/models/masterDb/ErpConfig.js definition (base columns + the
// legacy add-dynamic-sap-mapping-to-erp-configs ALTER, consolidated).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("erp_configs", {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: Sequelize.STRING, allowNull: false },
      sapClient: { type: Sequelize.STRING, defaultValue: "100" },
      description: { type: Sequelize.STRING },
      status: {
        type: Sequelize.ENUM("PENDING", "CONNECTED", "FAILED", "INACTIVE", "ACTIVE"),
        defaultValue: "PENDING",
      },
      isDefault: { type: Sequelize.BOOLEAN, defaultValue: false },
      erpType: { type: Sequelize.ENUM("SAP", "ORACLE", "CUSTOM"), allowNull: false },
      baseUrl: { type: Sequelize.TEXT, allowNull: true },
      integrationMode: {
        type: Sequelize.ENUM("INBOUND", "OUTBOUND", "BOTH"),
        allowNull: false,
        defaultValue: "BOTH",
      },
      inboundUsername: { type: Sequelize.STRING, allowNull: true, unique: true },
      inboundPassword: { type: Sequelize.STRING, allowNull: true },
      username: { type: Sequelize.STRING },
      password: { type: Sequelize.STRING },
      authType: { type: Sequelize.ENUM("BASIC", "BEARER", "API_KEY"), defaultValue: "BASIC" },
      apiKey: { type: Sequelize.TEXT },
      metadataUrl: { type: Sequelize.TEXT, allowNull: true },
      odataVersion: { type: Sequelize.STRING, allowNull: false, defaultValue: "v2" },
      entitySetMap: { type: Sequelize.JSON, allowNull: true },
      fieldMap: { type: Sequelize.JSON, allowNull: true },
      functionMap: { type: Sequelize.JSON, allowNull: true },
      metadataSnapshot: { type: Sequelize.JSON, allowNull: true },
      metadataFetchedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable("erp_configs");
  },
};
