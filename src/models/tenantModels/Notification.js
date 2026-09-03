// src/models/tenantModels/Notification.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below were
// originally byte-for-byte unchanged from the legacy
// src/models/Notification.js; MERGE added two communication-related
// enum values below (additive only, see comments inline).
const { DataTypes } = require("sequelize");

// In-app dashboard notifications (bell icon / notification center).
// userId=null = tenant-wide (every user of that tenant sees it) — this is
// how trial-expiry banners are delivered; see subscriptionScheduler.js.
module.exports = (sequelize) => sequelize.define(
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
        // MERGE — Internal Communication Module — new message while the
        // recipient wasn't actively viewing the conversation. Additive only.
        "COMMUNICATION_MESSAGE",
        // Missed audio/video call.
        "COMMUNICATION_MISSED_CALL",
      ),
      allowNull: false,
      defaultValue: "SYSTEM",
    },
    title: { type: DataTypes.STRING, allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    isRead: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: "notifications",
    timestamps: true,
  },
);

