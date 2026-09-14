"use strict";

// Plan catalog. This table is the extensibility point: adding
// Professional/Enterprise/Premium later is a new row here (+ PlanFeature
// rows), never a code change. code is what business logic keys off of
// only for the two hard-wired concepts (FREE vs PAID trial/watermark
// rules) — every other capability difference is data-driven via
// PlanFeature, not the plan code.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("plans", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      code: { type: Sequelize.STRING, allowNull: false, unique: true },
      name: { type: Sequelize.STRING, allowNull: false },
      isTrialable: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      trialDurationDays: { type: Sequelize.INTEGER, allowNull: true },
      priceMonthly: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      priceYearly: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("plans");
  },
};
