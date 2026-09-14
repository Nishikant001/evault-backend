// src/models/tenantModels/ChatSession.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/ChatSession.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "ChatSession",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
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

