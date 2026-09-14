// src/models/masterDb/Plan.js — PHASE A, real Master DB model.
// Field-for-field identical to legacy src/models/Plan.js. Plan catalog is
// unambiguously platform-level (same plan definitions apply across every
// tenant), so it belongs in the Master DB.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const Plan = masterSequelize.define(
  "Plan",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING, allowNull: false, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    isTrialable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    trialDurationDays: { type: DataTypes.INTEGER, allowNull: true },
    priceMonthly: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    priceYearly: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "plans",
    timestamps: true,
  },
);

module.exports = Plan;
