"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("ai_providers", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
        comment: "null = platform-wide provider configured by SuperAdmin; non-null = tenant-specific override",
      },
      name: { type: Sequelize.STRING, allowNull: false },
      providerType: {
        type: Sequelize.ENUM("OPENAI", "ANTHROPIC", "GEMINI", "AZURE_OPENAI", "OLLAMA"),
        allowNull: false,
      },
      apiKeyEncrypted: { type: Sequelize.TEXT, allowNull: true },
      baseUrl: { type: Sequelize.STRING, allowNull: true },
      chatModel: { type: Sequelize.STRING, allowNull: true },
      embeddingModel: { type: Sequelize.STRING, allowNull: true },
      apiVersion: { type: Sequelize.STRING, allowNull: true, comment: "Azure OpenAI api-version, if applicable" },
      extraConfigJson: { type: Sequelize.JSON, allowNull: true, comment: "e.g. Azure deployment name, Gemini projectId" },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      isDefault: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("ai_providers", ["tenantId", "providerType"], {
      name: "idx_ai_providers_tenant_type",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("ai_providers");
  },
};
