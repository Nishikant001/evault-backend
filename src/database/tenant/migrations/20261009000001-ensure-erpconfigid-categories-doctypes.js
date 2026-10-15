// Ensure SAP ERP mapping columns exist on every tenant database.
// This migration is deliberately additive and idempotent: it never drops or
// rewrites existing data, and it does not call sequelize.sync().
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableNames = await queryInterface.showAllTables();
    const normalizedNames = new Set(tableNames.map((name) => String(name).toLowerCase()));

    for (const tableName of ["categories", "document_types"]) {
      if (!normalizedNames.has(tableName.toLowerCase())) {
        throw new Error(
          `Cannot apply ERP mapping migration: required tenant table "${tableName}" does not exist.`,
        );
      }

      const columns = await queryInterface.describeTable(tableName);
      if (!columns.erpConfigId) {
        await queryInterface.addColumn(tableName, "erpConfigId", {
          type: Sequelize.INTEGER,
          allowNull: true,
        });
      }
    }
  },

  // Intentionally no down migration: removing these columns could discard ERP
  // mapping data after the feature has been used.
  async down() {},
};
