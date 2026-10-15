module.exports = {
  async up(queryInterface, Sequelize, sequelize) {
    const { defineTenantModels } = require("../../../models/tenantModels");
    defineTenantModels(sequelize);
    await sequelize.sync();

    const table = await queryInterface.describeTable("documents");
    if (!table.erpConfigId) {
      await queryInterface.addColumn("documents", "erpConfigId", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
      await queryInterface.addIndex("documents", ["tenantId", "erpConfigId"]);
    }
  },
  async down() {},
};