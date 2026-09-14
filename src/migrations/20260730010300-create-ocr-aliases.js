"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("ocr_aliases", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      metadataFieldId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "metadata_fields", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      alias: { type: Sequelize.STRING, allowNull: false },
      status: {
        type: Sequelize.ENUM("ACTIVE", "INACTIVE"),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(
      "ocr_aliases",
      ["metadataFieldId", "alias"],
      { unique: true, name: "unique_alias_per_field" }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("ocr_aliases");
  },
};
