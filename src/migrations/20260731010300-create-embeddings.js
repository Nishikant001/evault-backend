"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("embeddings", {
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
        unique: true,
        references: { model: "documents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      status: {
        type: Sequelize.ENUM("PENDING", "PROCESSING", "INDEXED", "FAILED", "SKIPPED_NO_TEXT"),
        allowNull: false,
        defaultValue: "PENDING",
      },
      vectorStoreProvider: { type: Sequelize.STRING, allowNull: true },
      embeddingProvider: { type: Sequelize.STRING, allowNull: true },
      embeddingModel: { type: Sequelize.STRING, allowNull: true },
      chunkCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      lastIndexedAt: { type: Sequelize.DATE, allowNull: true },
      errorMessage: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("embeddings");
  },
};
