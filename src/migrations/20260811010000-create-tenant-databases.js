"use strict";

// Compatibility shim table — see src/models/TenantDatabase.js for why this
// exists and what it does NOT do (it is not a record of a real separate
// physical tenant database; everything still lives in the one shared DB).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("tenant_databases", {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: "tenants", key: "id" },
        onDelete: "CASCADE",
      },
      databaseName: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM("PROVISIONING", "READY", "FAILED"),
        allowNull: false,
        defaultValue: "READY",
      },
      provisionedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      documentCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      userCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // Backfill one READY row per existing tenant so getAll()'s
    // `include: [{ model: TenantDatabase }]` doesn't just return null
    // for every tenant created before this migration ran.
    await queryInterface.sequelize.query(`
      INSERT INTO tenant_databases (tenantId, status, documentCount, userCount, createdAt, updatedAt)
      SELECT id, 'READY', 0, 0, NOW(), NOW() FROM tenants
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("tenant_databases");
  },
};
