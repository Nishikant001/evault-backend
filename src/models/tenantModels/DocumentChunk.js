// src/models/tenantModels/DocumentChunk.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/DocumentChunk.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// One row per chunk of a document's extracted text. embeddingJson holds the
// raw vector when vectorStoreProvider = MYSQL (default, brute-force cosine
// similarity — see services/vectorStore/mysqlVectorStore.js). When an
// external vector DB is configured (pgvector/Pinecone/Qdrant), the vector
// itself lives there and externalVectorId is the pointer back to it.
module.exports = (sequelize) => sequelize.define(
  "DocumentChunk",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    documentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "documents", key: "id" },
    },
    chunkIndex: { type: DataTypes.INTEGER, allowNull: false },
    pageNumber: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 1 },
    content: { type: DataTypes.TEXT("long"), allowNull: false },
    tokenCount: { type: DataTypes.INTEGER, allowNull: true },
    embeddingProvider: { type: DataTypes.STRING, allowNull: true },
    embeddingModel: { type: DataTypes.STRING, allowNull: true },
    embeddingDim: { type: DataTypes.INTEGER, allowNull: true },
    embeddingJson: { type: DataTypes.JSON, allowNull: true },
    externalVectorId: { type: DataTypes.STRING, allowNull: true },
    metadataJson: { type: DataTypes.JSON, allowNull: true },
  },
  {
    tableName: "document_chunks",
    timestamps: true,
  }
);

