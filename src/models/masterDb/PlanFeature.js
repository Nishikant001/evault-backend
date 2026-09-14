// src/models/masterDb/PlanFeature.js — PHASE A, real Master DB model.
// Field-for-field identical to legacy src/models/PlanFeature.js.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const PlanFeature = masterSequelize.define(
  "PlanFeature",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    planId: { type: DataTypes.INTEGER, allowNull: false },
    featureKey: { type: DataTypes.STRING, allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    limitValue: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: "plan_features",
    timestamps: true,
    indexes: [{ unique: true, fields: ["planId", "featureKey"] }],
  },
);

module.exports = PlanFeature;
