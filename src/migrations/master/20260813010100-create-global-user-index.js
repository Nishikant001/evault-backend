"use strict";

// MASTER DB migration — PHASE D. See src/models/masterDb/GlobalUserIndex.js
// for why this table exists: cross-tenant email/mobile uniqueness at
// registration time, now that User rows live in per-tenant databases.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("global_user_index", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      email: { type: Sequelize.STRING, allowNull: false, unique: true },
      mobileNumber: { type: Sequelize.STRING, allowNull: true, unique: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onDelete: "CASCADE",
      },
      tenantUserId: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("global_user_index");
  },
};
