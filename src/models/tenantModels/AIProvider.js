// src/models/tenantModels/AIProvider.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/AIProvider.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// Stores per-tenant (or platform-wide, when tenantId is null) LLM provider
// credentials/config. apiKeyEncrypted is encrypted at rest by
// aiProviderService (see utils/cryptoUtil.js) — never store plaintext keys.
module.exports = (sequelize) => sequelize.define(
  "AIProvider",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    name: { type: DataTypes.STRING, allowNull: false },
    providerType: {
      type: DataTypes.ENUM("OPENAI", "ANTHROPIC", "GEMINI", "AZURE_OPENAI", "OLLAMA"),
      allowNull: false,
    },
    apiKeyEncrypted: { type: DataTypes.TEXT, allowNull: true },
    baseUrl: { type: DataTypes.STRING, allowNull: true },
    chatModel: { type: DataTypes.STRING, allowNull: true },
    embeddingModel: { type: DataTypes.STRING, allowNull: true },
    apiVersion: { type: DataTypes.STRING, allowNull: true },
    extraConfigJson: { type: DataTypes.JSON, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
  },
  {
    tableName: "ai_providers",
    timestamps: true,
  }
);

