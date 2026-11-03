module.exports = {
  async up(queryInterface, Sequelize, sequelize) {
    const tableName = "sap_sync_retry_queue";

    const tables = (await queryInterface.showAllTables())
      .map((table) => String(
        typeof table === "object" ? Object.values(table)[0] : table
      ).toLowerCase());

    // If the table does not exist, create the tenant schema from models.
    if (!tables.includes(tableName.toLowerCase())) {
      const { defineTenantModels } = require("../../../models/tenantModels");
      defineTenantModels(sequelize);
      await sequelize.sync();
    }

    // Ensure the ERP column exists BEFORE creating indexes that reference it.
    let columns = await queryInterface.describeTable(tableName);

    if (!columns.erpConfigId) {
      await queryInterface.addColumn(tableName, "erpConfigId", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    columns = await queryInterface.describeTable(tableName);

    if (!columns.erpConfigId) {
      throw new Error(
        "Migration stopped: erpConfigId column is still missing from " + tableName
      );
    }

    const indexes = await queryInterface.showIndex(tableName);

    const oldUnique = indexes.find(
      (index) => index.name === "unique_retry_item_per_tenant"
    );

    if (oldUnique) {
      await queryInterface.removeIndex(
        tableName,
        "unique_retry_item_per_tenant"
      );
    }

    const newUnique = indexes.find(
      (index) => index.name === "unique_retry_item_per_tenant_erp"
    );

    if (!newUnique) {
      await queryInterface.addIndex(
        tableName,
        ["tenantId", "erpConfigId", "entityType", "referenceCode"],
        {
          unique: true,
          name: "unique_retry_item_per_tenant_erp",
        }
      );
    }

    const refreshedIndexes = await queryInterface.showIndex(tableName);

    const lookupIndex = refreshedIndexes.find(
      (index) =>
        index.name === "sap_sync_retry_queue_tenant_id_erp_config_id"
    );

    if (!lookupIndex) {
      await queryInterface.addIndex(
        tableName,
        ["tenantId", "erpConfigId"],
        { name: "sap_sync_retry_queue_tenant_id_erp_config_id" }
      );
    }

    console.log("ERP retry queue migration completed.");
  },

  async down() {
    // Intentionally non-destructive.
  },
};
