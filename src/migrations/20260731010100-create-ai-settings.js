"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("ai_settings", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      defaultChatProviderId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "ai_providers", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      defaultEmbeddingProviderId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "ai_providers", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      vectorStoreProvider: {
        type: Sequelize.ENUM("MYSQL", "PGVECTOR", "PINECONE", "QDRANT"),
        allowNull: false,
        defaultValue: "MYSQL",
      },
      vectorStoreConfigJson: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: "e.g. { indexName, collectionName, namespace }",
      },
      chunkSize: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1200 },
      chunkOverlap: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 200 },
      topK: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 6 },
      temperature: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 0.2 },
      autoIndexOnUpload: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      isEnabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("ai_settings");
  },
};
