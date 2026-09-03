const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const SubscriptionHistory = sequelize.define(
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
