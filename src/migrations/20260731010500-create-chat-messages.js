"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("chat_messages", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      sessionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "chat_sessions", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      role: { type: Sequelize.ENUM("USER", "ASSISTANT", "SYSTEM"), allowNull: false },
      content: { type: Sequelize.TEXT("long"), allowNull: false },
      citationsJson: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: "[{ documentId, documentName, pageNumber, chunkId, snippet, score }]",
      },
      confidenceScore: { type: Sequelize.FLOAT, allowNull: true },
      suggestedFollowUpsJson: { type: Sequelize.JSON, allowNull: true },
      provider: { type: Sequelize.STRING, allowNull: true },
      model: { type: Sequelize.STRING, allowNull: true },
      promptTokens: { type: Sequelize.INTEGER, allowNull: true },
      completionTokens: { type: Sequelize.INTEGER, allowNull: true },
      latencyMs: { type: Sequelize.INTEGER, allowNull: true },
      status: { type: Sequelize.ENUM("SUCCESS", "FAILED"), allowNull: false, defaultValue: "SUCCESS" },
      errorMessage: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("chat_messages", ["sessionId"], { name: "idx_chat_messages_session" });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("chat_messages");
  },
};
