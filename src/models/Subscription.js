const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// One row per tenant (unique tenantId). This is the row subscriptionMiddleware
// loads on every authenticated request to decide trial/expiry/feature access.
const Subscription = sequelize.define(
  "Subscription",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    planId: { type: DataTypes.INTEGER, allowNull: false },

    status: {
      type: DataTypes.ENUM("TRIAL", "ACTIVE", "EXPIRED", "SUSPENDED", "CANCELLED"),
      allowNull: false,
      defaultValue: "ACTIVE",
    },

    trialStartAt: { type: DataTypes.DATE, allowNull: true },
    trialEndAt: { type: DataTypes.DATE, allowNull: true },

    paymentStatus: {
      type: DataTypes.ENUM("NA", "PENDING", "PAID", "FAILED"),
      allowNull: false,
      defaultValue: "NA",
    },

    currentPeriodStart: { type: DataTypes.DATE, allowNull: true },
    currentPeriodEnd: { type: DataTypes.DATE, allowNull: true },
    autoRenew: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    lastReminderSentAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "subscriptions",
    timestamps: true,
  },
);

module.exports = Subscription;
