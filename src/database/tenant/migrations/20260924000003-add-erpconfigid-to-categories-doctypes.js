module.exports = {
  async up(queryInterface, Sequelize, sequelize) {
    const { defineTenantModels } = require("../../../models/tenantModels");
    defineTenantModels(sequelize);
    await sequelize.sync();

    for (const t of ["categories", "document_types"]) {
      const table = await queryInterface.describeTable(t);
      if (!table.erpConfigId) {
        await queryInterface.addColumn(t, "erpConfigId", {
          type: Sequelize.INTEGER,
          allowNull: true,
        });
      }
    }
  },
  async down() {},
};