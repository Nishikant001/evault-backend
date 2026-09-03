"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("document_chunks", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      documentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "documents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      chunkIndex: { type: Sequelize.INTEGER, allowNull: false },
      pageNumber: { type: Sequelize.INTEGER, allowNull: true, defaultValue: 1 },
      content: { type: Sequelize.TEXT("long"), allowNull: false },
      tokenCount: { type: Sequelize.INTEGER, allowNull: true },
      embeddingProvider: { type: Sequelize.STRING, allowNull: true },
      embeddingModel: { type: Sequelize.STRING, allowNull: true },
      embeddingDim: { type: Sequelize.INTEGER, allowNull: true },
      embeddingJson: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: "Float array embedding — populated for vectorStoreProvider=MYSQL. Null when the vector lives in an external store (externalVectorId set instead).",
      },
      externalVectorId: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: "id of this chunk's vector in Pinecone/Qdrant/pgvector, when not using the MYSQL vector store",
      },
      metadataJson: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: "Denormalized filter fields: departmentId, categoryId, documentTypeId, sapDocumentId, documentName",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("document_chunks", ["documentId"], { name: "idx_document_chunks_document" });
    await queryInterface.addIndex("document_chunks", ["tenantId"], { name: "idx_document_chunks_tenant" });
    await queryInterface.addIndex("document_chunks", ["documentId", "chunkIndex"], {
      unique: true,
      name: "unique_chunk_per_document_index",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("document_chunks");
  },
};
