"use strict";

// In-app dashboard notifications. userId=null means "tenant-wide" (shown
// to every user of that tenant, e.g. a trial-expiry banner) — used by
// subscriptionScheduler for trial reminders. A specific userId targets
// just that user.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("notifications", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onDelete: "CASCADE",
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      type: {
        type: Sequelize.ENUM("TRIAL_REMINDER", "TRIAL_EXPIRED", "SUBSCRIPTION_CHANGED", "SYSTEM"),
        allowNull: false,
        defaultValue: "SYSTEM",
      },
      title: { type: Sequelize.STRING, allowNull: false },
      message: { type: Sequelize.TEXT, allowNull: false },
      isRead: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("notifications", ["tenantId", "userId", "isRead"]);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("notifications");
  },
};
