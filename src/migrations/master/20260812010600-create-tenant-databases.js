"use strict";

// MASTER DB migration — the REAL tenant_databases table (see
// src/models/masterDb/TenantDatabase.js for how this differs from the
// Phase 5 shared-DB compatibility shim). No backfill INSERT here: a
// fresh Master DB has no tenants yet, and existing-tenant backfill /
// data migration into the new architecture is explicitly out of scope
// for this phase (see Phase 9 in the project brief) — this table is
// populated going forward by the real provisioning pipeline (Phase D).
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
        defaultValue: "PROVISIONING",
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
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("tenant_databases");
  },
};
