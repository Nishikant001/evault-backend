"use strict";

// MASTER DB migration — DYNAMIC ERP CONNECTOR, STEP 1.
//
// 1. erp_configs.erpType  ENUM('SAP','ORACLE','CUSTOM') -> VARCHAR(50)
//    so any number of ERP types can exist without a schema change.
// 2. erp_configs.authType ENUM('BASIC','BEARER','API_KEY') -> VARCHAR(30)
//    so NONE / OAUTH2_CLIENT_CREDENTIALS (and future modes) are possible.
// 3. New columns: protocol, connectorConfig (JSON), templateKey.
//
// Existing rows keep their values: SAP -> protocol ODATA, everything else
// -> REST, connectorConfig NULL (= "not configured yet", nothing changes
// for existing SAP tenants; the SAP engine does not read connectorConfig).
//
// Idempotent: safe to run twice.

const TABLE = "erp_configs";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const cols = await queryInterface.describeTable(TABLE);

    await queryInterface.changeColumn(TABLE, "erpType", {
      type: Sequelize.STRING(50),
      allowNull: false,
    });

    await queryInterface.changeColumn(TABLE, "authType", {
      type: Sequelize.STRING(30),
      allowNull: true,
      defaultValue: "BASIC",
    });

    if (!cols.protocol) {
      await queryInterface.addColumn(TABLE, "protocol", {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: "REST",
      });
      await queryInterface.sequelize.query(
        `UPDATE \`${TABLE}\` SET protocol = 'ODATA' WHERE erpType = 'SAP'`,
      );
    }

    if (!cols.connectorConfig) {
      await queryInterface.addColumn(TABLE, "connectorConfig", {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }

    if (!cols.templateKey) {
      await queryInterface.addColumn(TABLE, "templateKey", {
        type: Sequelize.STRING(100),
        allowNull: true,
      });
    }

    const indexes = await queryInterface.showIndex(TABLE);
    if (!indexes.some((i) => i.name === "erp_configs_erp_type")) {
      await queryInterface.addIndex(TABLE, ["erpType"], { name: "erp_configs_erp_type" });
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Refuse to silently corrupt data: reverting to the 3-value ENUM is
    // only possible while every row still uses one of those values.
    const [rows] = await queryInterface.sequelize.query(
      `SELECT DISTINCT erpType FROM \`${TABLE}\` WHERE erpType NOT IN ('SAP','ORACLE','CUSTOM')`,
    );
    if (rows.length) {
      throw new Error(
        `Cannot revert: erp_configs contains erpType values outside SAP/ORACLE/CUSTOM (${rows
          .map((r) => r.erpType)
          .join(", ")}). Change or delete those rows first.`,
      );
    }
    const [auth] = await queryInterface.sequelize.query(
      `SELECT DISTINCT authType FROM \`${TABLE}\` WHERE authType IS NOT NULL AND authType NOT IN ('BASIC','BEARER','API_KEY')`,
    );
    if (auth.length) {
      throw new Error(
        `Cannot revert: erp_configs contains authType values outside BASIC/BEARER/API_KEY (${auth
          .map((r) => r.authType)
          .join(", ")}).`,
      );
    }

    try { await queryInterface.removeIndex(TABLE, "erp_configs_erp_type"); } catch (e) { /* already gone */ }
    await queryInterface.removeColumn(TABLE, "templateKey");
    await queryInterface.removeColumn(TABLE, "connectorConfig");
    await queryInterface.removeColumn(TABLE, "protocol");

    await queryInterface.changeColumn(TABLE, "authType", {
      type: Sequelize.ENUM("BASIC", "BEARER", "API_KEY"),
      defaultValue: "BASIC",
    });
    await queryInterface.changeColumn(TABLE, "erpType", {
      type: Sequelize.ENUM("SAP", "ORACLE", "CUSTOM"),
      allowNull: false,
    });
  },
};