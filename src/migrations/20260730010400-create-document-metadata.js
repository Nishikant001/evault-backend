"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("document_metadata", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      documentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: "documents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      metadataTemplateVersionId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "metadata_template_versions", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      rawOcrJson: { type: Sequelize.JSON, allowNull: true },
      mappedMetadataJson: { type: Sequelize.JSON, allowNull: true },
      confidenceJson: { type: Sequelize.JSON, allowNull: true },
      validationErrorsJson: { type: Sequelize.JSON, allowNull: true },
      correctionHistory: { type: Sequelize.JSON, allowNull: true },
      status: {
        type: Sequelize.ENUM("PENDING_REVIEW", "CONFIRMED"),
        allowNull: false,
        defaultValue: "PENDING_REVIEW",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("document_metadata");
  },
};
