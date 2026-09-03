const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ChatSession = sequelize.define(
  "ChatSession",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "tenants", key: "id" },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
    },
    title: { type: DataTypes.STRING, allowNull: true },
    scopeType: {
      type: DataTypes.ENUM("ALL", "DOCUMENT", "DOCUMENT_SET", "FOLDER"),
      allowNull: false,
      defaultValue: "ALL",
    },
    scopeDocumentIds: { type: DataTypes.JSON, allowNull: true },
    scopeFolderJson: { type: DataTypes.JSON, allowNull: true },
    isArchived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    lastMessageAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "chat_sessions",
    timestamps: true,
  }
);

module.exports = ChatSession;
