"use strict";

// Feature flags per plan. All access-guard middleware reads THIS table
// (via featureKey), never a hardcoded plan-name check — that's what makes
// future plans (Professional/Enterprise/Premium) require zero business
// logic changes: they just get their own set of rows here.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("plan_features", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      planId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "plans", key: "id" },
        onDelete: "CASCADE",
      },
      featureKey: { type: Sequelize.STRING, allowNull: false },
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      limitValue: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("plan_features", ["planId", "featureKey"], {
      unique: true,
      name: "plan_features_plan_feature_unique",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("plan_features");
  },
};
