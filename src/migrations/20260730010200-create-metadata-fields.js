"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("metadata_fields", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      metadataTemplateVersionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "metadata_template_versions", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      label: { type: Sequelize.STRING, allowNull: false },
      internalName: { type: Sequelize.STRING, allowNull: false },
      placeholder: { type: Sequelize.STRING, allowNull: true },
      fieldType: {
        type: Sequelize.ENUM(
          "TEXT", "TEXTAREA", "NUMBER", "CURRENCY", "DATE", "TIME",
          "CHECKBOX", "RADIO", "DROPDOWN", "MULTI_SELECT", "EMAIL", "PHONE",
          "URL", "PASSWORD", "SIGNATURE", "BARCODE", "QR", "AUTO_NUMBER",
          "FORMULA", "HIDDEN", "LOOKUP", "FILE", "IMAGE"
        ),
        allowNull: false,
        defaultValue: "TEXT",
      },
      required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      defaultValue: { type: Sequelize.STRING, allowNull: true },
      displayOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      validation: { type: Sequelize.JSON, allowNull: true },
      options: { type: Sequelize.JSON, allowNull: true },
      helpText: { type: Sequelize.TEXT, allowNull: true },
      tooltip: { type: Sequelize.STRING, allowNull: true },
      searchable: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      sapField: { type: Sequelize.STRING, allowNull: true },
      confidenceThreshold: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 0.75 },
      readonly: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      hidden: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      status: {
        type: Sequelize.ENUM("ACTIVE", "INACTIVE"),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(
      "metadata_fields",
      ["metadataTemplateVersionId", "internalName"],
      { unique: true, name: "unique_field_internalname_per_version" }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("metadata_fields");
  },
};
