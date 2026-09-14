const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// One row per chunk of a document's extracted text. embeddingJson holds the
// raw vector when vectorStoreProvider = MYSQL (default, brute-force cosine
// similarity — see services/vectorStore/mysqlVectorStore.js). When an
// external vector DB is configured (pgvector/Pinecone/Qdrant), the vector
// itself lives there and externalVectorId is the pointer back to it.
const DocumentChunk = sequelize.define(
  "DocumentChunk",
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

module.exports = DocumentChunk;
