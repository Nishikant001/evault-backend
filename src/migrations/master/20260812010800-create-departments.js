"use strict";

// MASTER DB migration. Written from src/models/masterDb/Department.js —
// same no-pre-existing-create-migration situation as tenants/erp_configs.
// `plantId` is kept as a plain nullable integer (deprecated, no FK) since
// Plant now lives in the Tenant DB, not here — see the model's comment.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("departments", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      plantId: { type: Sequelize.INTEGER, allowNull: true },
      name: { type: Sequelize.STRING, allowNull: false, unique: true },
      code: { type: Sequelize.STRING, allowNull: false, unique: true },
      description: { type: Sequelize.TEXT, allowNull: true },
      status: { type: Sequelize.ENUM("ACTIVE", "INACTIVE"), defaultValue: "ACTIVE" },
      sapCode: { type: Sequelize.STRING, allowNull: true, unique: true },
      lastSyncedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable("departments");
  },
};
