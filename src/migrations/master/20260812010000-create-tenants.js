"use strict";

// MASTER DB migration.
//
// IMPORTANT CONTEXT: unlike most tables in this project, `tenants` has NO
// pre-existing "create" migration anywhere in src/migrations — the
// original backend created it via `sequelize.sync({ alter: true })` at
// boot (see src/app.js), and only later ALTER-style migrations
// (add-tenant-type-to-tenants, add-metadata-to-tenants) were ever
// written against it. Since the Master DB is a brand new physical
// database, it needs the full table from scratch. This migration is
// written to match the current src/models/Tenant.js /
// src/models/masterDb/Tenant.js definition exactly (base columns +
// everything since added by the two ALTER migrations), so a fresh
// Master DB ends up schema-identical to what an existing shared DB's
// `tenants` table looks like today.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("tenants", {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      tenantName: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      tenantCode: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      erpConfigId: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM("ACTIVE", "INACTIVE"),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      tenantType: {
        type: Sequelize.ENUM("FREE", "PAID"),
        allowNull: false,
        defaultValue: "PAID",
        comment:
          "FREE = self-registered trial tenant (no SAP/AI access, watermarked documents, local storage only). PAID = existing enterprise tenant, unchanged behavior.",
      },
      metadata: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("tenants");
  },
};
