const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ChatMessage = sequelize.define(
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
      references: { model: "tenants", key: "id" },
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

module.exports = ChatMessage;
