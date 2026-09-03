// src/models/tenantModels/ChatMessage.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/ChatMessage.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "ChatMessage",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    sessionId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "chat_sessions", key: "id" },
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    role: { type: DataTypes.ENUM("USER", "ASSISTANT", "SYSTEM"), allowNull: false },
    content: { type: DataTypes.TEXT("long"), allowNull: false },
    citationsJson: { type: DataTypes.JSON, allowNull: true },
    confidenceScore: { type: DataTypes.FLOAT, allowNull: true },
    suggestedFollowUpsJson: { type: DataTypes.JSON, allowNull: true },
    provider: { type: DataTypes.STRING, allowNull: true },
    model: { type: DataTypes.STRING, allowNull: true },
    promptTokens: { type: DataTypes.INTEGER, allowNull: true },
    completionTokens: { type: DataTypes.INTEGER, allowNull: true },
    latencyMs: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.ENUM("SUCCESS", "FAILED"), allowNull: false, defaultValue: "SUCCESS" },
    errorMessage: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "chat_messages",
    timestamps: true,
  }
);

