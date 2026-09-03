"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("prompt_history", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
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
      sessionId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "chat_sessions", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      feature: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: "CHAT | SUMMARIZE | EXPLAIN | COMPARE | CLASSIFY | AUTO_TAG | DUPLICATE_CHECK | METADATA_CHECK | OCR_CONSISTENCY | VALIDATE_TOTALS | FOLDER_SUGGEST",
      },
      provider: { type: Sequelize.STRING, allowNull: true },
      model: { type: Sequelize.STRING, allowNull: true },
      prompt: { type: Sequelize.TEXT("long"), allowNull: false },
      response: { type: Sequelize.TEXT("long"), allowNull: true },
      citationsJson: { type: Sequelize.JSON, allowNull: true },
      promptTokens: { type: Sequelize.INTEGER, allowNull: true },
      completionTokens: { type: Sequelize.INTEGER, allowNull: true },
      totalTokens: { type: Sequelize.INTEGER, allowNull: true },
      latencyMs: { type: Sequelize.INTEGER, allowNull: true },
      status: { type: Sequelize.ENUM("SUCCESS", "FAILED"), allowNull: false, defaultValue: "SUCCESS" },
      errorMessage: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("prompt_history", ["tenantId", "feature"], { name: "idx_prompt_history_tenant_feature" });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("prompt_history");
  },
};
