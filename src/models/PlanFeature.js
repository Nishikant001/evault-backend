const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// See constants/subscriptionConstants.js for the canonical FEATURE_KEYS
// list (SAP_SYNC, AI_ASSISTANT, AI_CHAT, AI_SEARCH, VECTOR_SEARCH, OCR,
// APPROVAL_WORKFLOW, SEARCH, METADATA, ANALYTICS, REPORTS, WATERMARK,
// NOTIFICATIONS, ...). Every access-guard middleware reads this table by
// featureKey — never by plan name — which is what lets a new plan tier be
// added purely as data.
const PlanFeature = sequelize.define(
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
