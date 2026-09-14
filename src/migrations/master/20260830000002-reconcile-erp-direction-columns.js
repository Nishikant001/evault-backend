"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Repair/complete the direction-aware ERP schema safely for databases
    // where the previous migration was partially applied or columns were
    // added manually. Every operation is guarded by SHOW COLUMNS.
    const [rows] = await queryInterface.sequelize.query(
      "SHOW COLUMNS FROM `erp_configs`"
    );
    const existing = new Set(rows.map((row) => row.Field));

    if (existing.has("baseUrl")) {
      await queryInterface.changeColumn("erp_configs", "baseUrl", {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }

    if (!existing.has("integrationMode")) {
      await queryInterface.addColumn("erp_configs", "integrationMode", {
        type: Sequelize.ENUM("INBOUND", "OUTBOUND", "BOTH"),
        allowNull: false,
        defaultValue: "BOTH",
      });
    }

    if (!existing.has("inboundUsername")) {
      await queryInterface.addColumn("erp_configs", "inboundUsername", {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true,
      });
    }

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
      await queryInterface.removeColumn("erp_configs", "inboundPassword");
    }
    if (existing.has("inboundUsername")) {
      await queryInterface.removeColumn("erp_configs", "inboundUsername");
    }
    if (existing.has("integrationMode")) {
      await queryInterface.removeColumn("erp_configs", "integrationMode");
    }
    if (existing.has("baseUrl")) {
      await queryInterface.changeColumn("erp_configs", "baseUrl", {
        type: Sequelize.TEXT,
        allowNull: false,
      });
    }
  },
};
