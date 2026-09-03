// src/models/tenantModels/AISettings.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/AISettings.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// One row per tenant. Controls which providers/vector store the AI
// Document Assistant uses for that tenant, plus RAG tuning knobs.
module.exports = (sequelize) => sequelize.define(
  "AISettings",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
    },
    defaultChatProviderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "ai_providers", key: "id" },
    },
    defaultEmbeddingProviderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "ai_providers", key: "id" },
    },
    vectorStoreProvider: {
      type: DataTypes.ENUM("MYSQL", "PGVECTOR", "PINECONE", "QDRANT"),
      allowNull: false,
      defaultValue: "MYSQL",
    },
    vectorStoreConfigJson: { type: DataTypes.JSON, allowNull: true },
    chunkSize: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1200 },
    chunkOverlap: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 200 },
    topK: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 6 },
    temperature: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0.2 },
    autoIndexOnUpload: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "ai_settings",
    timestamps: true,
  }
);

