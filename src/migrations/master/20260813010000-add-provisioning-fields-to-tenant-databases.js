"use strict";

// MASTER DB migration — PHASE D. Additive-only columns on tenant_databases
// so the provisioning pipeline can record WHY a provisioning attempt
// failed (brief section 9: "Store: error message, error code if
// available, failed step, timestamp") and support safe retries
// (provisioningAttempts).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("tenant_databases", "provisioningAttempts", {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn("tenant_databases", "failedStep", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn("tenant_databases", "lastErrorCode", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn("tenant_databases", "lastError", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("tenant_databases", "failedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("tenant_databases", "provisioningAttempts");
    await queryInterface.removeColumn("tenant_databases", "failedStep");
    await queryInterface.removeColumn("tenant_databases", "lastErrorCode");
    await queryInterface.removeColumn("tenant_databases", "lastError");
    await queryInterface.removeColumn("tenant_databases", "failedAt");
  },
};
