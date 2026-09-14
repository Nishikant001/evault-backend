"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const [rows] = await queryInterface.sequelize.query(
      "SHOW COLUMNS FROM `erp_configs`"
    );

    const existing = new Set(rows.map((row) => row.Field));

    // Ensure baseUrl has the expected nullable definition.
    if (existing.has("baseUrl")) {
      await queryInterface.changeColumn("erp_configs", "baseUrl", {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }

    // Add only if missing.
    if (!existing.has("integrationMode")) {
      await queryInterface.addColumn("erp_configs", "integrationMode", {
        type: Sequelize.ENUM("INBOUND", "OUTBOUND", "BOTH"),
        allowNull: false,
        defaultValue: "BOTH",
      });
    }

    // Add only if missing.
    if (!existing.has("inboundUsername")) {
      await queryInterface.addColumn("erp_configs", "inboundUsername", {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true,
      });
    }

    // Add only if missing.
    if (!existing.has("inboundPassword")) {
      await queryInterface.addColumn("erp_configs", "inboundPassword", {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    const [rows] = await queryInterface.sequelize.query(
      "SHOW COLUMNS FROM `erp_configs`"
    );

    const existing = new Set(rows.map((row) => row.Field));

    if (existing.has("inboundPassword")) {
      await queryInterface.removeColumn(
        "erp_configs",
        "inboundPassword"
      );
    }

    if (existing.has("inboundUsername")) {
      await queryInterface.removeColumn(
        "erp_configs",
        "inboundUsername"
      );
    }

    if (existing.has("integrationMode")) {
      await queryInterface.removeColumn(
        "erp_configs",
        "integrationMode"
      );
    }

    if (existing.has("baseUrl")) {
      await queryInterface.changeColumn("erp_configs", "baseUrl", {
        type: Sequelize.TEXT,
        allowNull: false,
      });
    }
  },
};