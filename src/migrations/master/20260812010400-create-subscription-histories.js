"use strict";

// Audit trail for every subscription lifecycle event, mirroring the
// pattern already used by AuditLog elsewhere in this codebase.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("subscription_histories", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onDelete: "CASCADE",
      },
      fromPlanId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "plans", key: "id" },
      },
      toPlanId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "plans", key: "id" },
      },
      action: {
        type: Sequelize.ENUM(
          "CREATED",
          "UPGRADE",
          "DOWNGRADE",
          "TRIAL_EXTENDED",
          "TRIAL_DEACTIVATED",
          "CONVERTED_FREE_TO_PAID",
          "EXPIRED",
          "RENEWED",
          "SUSPENDED",
          "REACTIVATED"
        ),
        allowNull: false,
      },
      performedBy: { type: Sequelize.INTEGER, allowNull: true, comment: "userId, null = system/scheduler" },
      reason: { type: Sequelize.STRING, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("subscription_histories");
  },
};
