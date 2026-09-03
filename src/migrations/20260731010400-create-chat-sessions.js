"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("chat_sessions", {
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
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      title: { type: Sequelize.STRING, allowNull: true },
      scopeType: {
        type: Sequelize.ENUM("ALL", "DOCUMENT", "DOCUMENT_SET", "FOLDER"),
        allowNull: false,
        defaultValue: "ALL",
      },
      scopeDocumentIds: { type: Sequelize.JSON, allowNull: true },
      scopeFolderJson: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: "{ departmentId, categoryId, documentTypeId } — any subset",
      },
      isArchived: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      lastMessageAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("chat_sessions", ["tenantId", "userId"], { name: "idx_chat_sessions_tenant_user" });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("chat_sessions");
  },
};
