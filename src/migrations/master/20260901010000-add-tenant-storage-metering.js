"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("tenant_databases", "databaseDataBytes", {
      type: Sequelize.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn("tenant_databases", "databaseIndexBytes", {
      type: Sequelize.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn("tenant_databases", "databaseBytes", {
      type: Sequelize.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn("tenant_databases", "fileBytes", {
      type: Sequelize.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn("tenant_databases", "totalBytes", {
      type: Sequelize.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn("tenant_databases", "databaseQuotaBytes", {
      type: Sequelize.BIGINT,
      allowNull: true,
    });
    await queryInterface.addColumn("tenant_databases", "fileQuotaBytes", {
      type: Sequelize.BIGINT,
      allowNull: true,
    });
    await queryInterface.addColumn("tenant_databases", "storageMeasuredAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    for (const column of [
      "storageMeasuredAt",
      "fileQuotaBytes",
      "databaseQuotaBytes",
      "totalBytes",
      "fileBytes",
      "databaseBytes",
      "databaseIndexBytes",
      "databaseDataBytes",
    ]) {
      await queryInterface.removeColumn("tenant_databases", column);
    }
  },
};
