"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("metadata_template_versions", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      metadataTemplateId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "metadata_templates", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      versionNumber: { type: Sequelize.INTEGER, allowNull: false },
      status: {
        type: Sequelize.ENUM("DRAFT", "PUBLISHED", "ARCHIVED"),
        allowNull: false,
        defaultValue: "DRAFT",
      },
      notes: { type: Sequelize.TEXT, allowNull: true },
      publishedAt: { type: Sequelize.DATE, allowNull: true },
      publishedBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
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

    await queryInterface.addIndex(
      "metadata_template_versions",
      ["metadataTemplateId", "versionNumber"],
      { unique: true, name: "unique_version_per_template" }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("metadata_template_versions");
  },
};
