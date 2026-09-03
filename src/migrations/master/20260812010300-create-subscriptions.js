"use strict";

// One active subscription row per tenant. This is what subscriptionMiddleware
// actually reads on every request (via loadSubscription) to decide trial
// status / feature access — Tenant.tenantType is only used for the couple
// of hard-wired PAID-vs-FREE rules (watermark, local-only storage).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("subscriptions", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: "tenants", key: "id" },
        onDelete: "CASCADE",
      },
      planId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "plans", key: "id" },
      },
      status: {
        type: Sequelize.ENUM("TRIAL", "ACTIVE", "EXPIRED", "SUSPENDED", "CANCELLED"),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      trialStartAt: { type: Sequelize.DATE, allowNull: true },
      trialEndAt: { type: Sequelize.DATE, allowNull: true },
      paymentStatus: {
        type: Sequelize.ENUM("NA", "PENDING", "PAID", "FAILED"),
        allowNull: false,
        defaultValue: "NA",
      },
      currentPeriodStart: { type: Sequelize.DATE, allowNull: true },
      currentPeriodEnd: { type: Sequelize.DATE, allowNull: true },
      autoRenew: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      lastReminderSentAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("subscriptions");
  },
};
