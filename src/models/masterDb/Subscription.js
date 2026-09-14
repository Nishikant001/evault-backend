// src/models/masterDb/Subscription.js — PHASE A, real Master DB model.
// Field-for-field identical to legacy src/models/Subscription.js.
// Billing/plan state is platform-level even though it's read on every
// tenant request (subscriptionMiddleware) — it governs access, it isn't
// itself tenant operational data.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const Subscription = masterSequelize.define(
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
