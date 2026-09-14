const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Flat, feature-agnostic log of every AI call made (chat turns AND
// document-AI features like summarize/compare/classify). Separate from
// ChatMessage, which only models conversational turns — this table exists
// for usage auditing, billing/token reporting, and troubleshooting across
// every AI surface.
const PromptHistory = sequelize.define(
  "PromptHistory",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "tenants", key: "id" },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    sessionId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "chat_sessions", key: "id" },
    },
    feature: { type: DataTypes.STRING, allowNull: false },
    provider: { type: DataTypes.STRING, allowNull: true },
    model: { type: DataTypes.STRING, allowNull: true },
    prompt: { type: DataTypes.TEXT("long"), allowNull: false },
    response: { type: DataTypes.TEXT("long"), allowNull: true },
    citationsJson: { type: DataTypes.JSON, allowNull: true },
    promptTokens: { type: DataTypes.INTEGER, allowNull: true },
    completionTokens: { type: DataTypes.INTEGER, allowNull: true },
    totalTokens: { type: DataTypes.INTEGER, allowNull: true },
    latencyMs: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.ENUM("SUCCESS", "FAILED"), allowNull: false, defaultValue: "SUCCESS" },
    errorMessage: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "prompt_history",
    timestamps: true,
  }
);

module.exports = PromptHistory;
