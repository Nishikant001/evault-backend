const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// One row per Document — tracks the state of that document's RAG indexing
// pipeline (chunk -> embed -> store). Re-index (POST /api/ai/documents/:id/reindex)
// updates this same row rather than creating a new one.
const Embedding = sequelize.define(
  "Embedding",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "tenants", key: "id" },
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

module.exports = Embedding;
