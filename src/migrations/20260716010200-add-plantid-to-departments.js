"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("departments", "plantId", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: "plants", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("departments", "plantId");
  },
};
