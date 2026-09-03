// src/models/masterDb/SubscriptionHistory.js — PHASE A, real Master DB model.
// Field-for-field identical to legacy src/models/SubscriptionHistory.js.
//
// `performedBy` deliberately stays a plain INTEGER with no Sequelize
// association here (the legacy shared-DB version has
// `SubscriptionHistory.belongsTo(User, { as: "performer" })`, but User is
// tenant-operational data that will live in a per-tenant physical
// database — a real cross-database Sequelize association isn't possible,
// see the note in master/Tenant.js). Grep across controllers/services
// confirmed the `.performer` alias is never actually used at query time
// (only the plain `performedBy` integer is read/written), so nothing is
// lost by not reproducing that association here.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const SubscriptionHistory = masterSequelize.define(
  "SubscriptionHistory",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.INTEGER, allowNull: false },
    fromPlanId: { type: DataTypes.INTEGER, allowNull: true },
    toPlanId: { type: DataTypes.INTEGER, allowNull: true },
    action: {
      type: DataTypes.ENUM(
        "CREATED",
        "UPGRADE",
        "DOWNGRADE",
        "TRIAL_EXTENDED",
        "TRIAL_DEACTIVATED",
        "CONVERTED_FREE_TO_PAID",
        "EXPIRED",
        "RENEWED",
        "SUSPENDED",
        "REACTIVATED",
      ),
      allowNull: false,
    },
    performedBy: { type: DataTypes.INTEGER, allowNull: true },
    reason: { type: DataTypes.STRING, allowNull: true },
  },
  {
    tableName: "subscription_histories",
    timestamps: true,
  },
);

module.exports = SubscriptionHistory;
