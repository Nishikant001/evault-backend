const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// In-app dashboard notifications (bell icon / notification center).
// userId=null = tenant-wide (every user of that tenant sees it) — this is
// how trial-expiry banners are delivered; see subscriptionScheduler.js.
const Notification = sequelize.define(
  "Notification",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    type: {
  type: DataTypes.ENUM(
    "TRIAL_REMINDER",
    "TRIAL_EXPIRED",
    "SUBSCRIPTION_CHANGED",
    "SYSTEM",

    "COMMUNICATION_MESSAGE",
    "COMMUNICATION_MISSED_CALL",

    "APPROVAL_SUBMITTED",
    "APPROVAL_PENDING",
    "APPROVAL_APPROVED",
    "APPROVAL_COMPLETED",
    "APPROVAL_REJECTED",
    "APPROVAL_SENT_BACK",
    "APPROVAL_CANCELLED",
  ),
      allowNull: false,
      defaultValue: "SYSTEM",
    },
    title: { type: DataTypes.STRING, allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },

metadata: {
  type: DataTypes.JSON,
  allowNull: true,
},

isRead: {
  type: DataTypes.BOOLEAN,
  allowNull: false,
  defaultValue: false,
},
  },
  {
    tableName: "notifications",
    timestamps: true,
  },
);

module.exports = Notification;
