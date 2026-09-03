// src/models/tenantModels/Embedding.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/Embedding.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// One row per Document — tracks the state of that document's RAG indexing
// pipeline (chunk -> embed -> store). Re-index (POST /api/ai/documents/:id/reindex)
// updates this same row rather than creating a new one.
module.exports = (sequelize) => sequelize.define(
  "Embedding",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    documentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: "documents", key: "id" },
    },
    status: {
      type: DataTypes.ENUM("PENDING", "PROCESSING", "INDEXED", "FAILED", "SKIPPED_NO_TEXT"),
      allowNull: false,
      defaultValue: "PENDING",
    },
    vectorStoreProvider: { type: DataTypes.STRING, allowNull: true },
    embeddingProvider: { type: DataTypes.STRING, allowNull: true },
    embeddingModel: { type: DataTypes.STRING, allowNull: true },
    chunkCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastIndexedAt: { type: DataTypes.DATE, allowNull: true },
    errorMessage: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "embeddings",
    timestamps: true,
  }
);

