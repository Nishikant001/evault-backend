"use strict";

// MASTER DB migration — PHASE E. See src/models/masterDb/SuperAdmin.js
// for why platform administrators get their own Master DB table instead
// of living in a tenant's `users` table.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("super_admins", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING, allowNull: false },
      email: { type: Sequelize.STRING, allowNull: false, unique: true },
      password: { type: Sequelize.STRING, allowNull: false },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("super_admins");
  },
};
