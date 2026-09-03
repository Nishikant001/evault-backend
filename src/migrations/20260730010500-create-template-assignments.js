"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("template_assignments", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      documentTypeId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "document_types", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      metadataTemplateId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "metadata_templates", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      metadataTemplateVersionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "metadata_template_versions", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      assignedBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      status: {
        type: Sequelize.ENUM("ACTIVE", "INACTIVE"),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(
      "template_assignments",
      ["tenantId", "documentTypeId"],
      { unique: true, name: "unique_assignment_per_tenant_doctype" }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("template_assignments");
  },
};
