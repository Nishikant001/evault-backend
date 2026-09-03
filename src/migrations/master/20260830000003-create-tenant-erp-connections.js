const { DataTypes } = require("sequelize");

module.exports = {
  async up(queryInterface) {
    await queryInterface.createTable("tenant_erp_connections", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      tenantId: { type: DataTypes.INTEGER, allowNull: false },
      erpConfigId: { type: DataTypes.INTEGER, allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    await queryInterface.addIndex("tenant_erp_connections", ["tenantId", "erpConfigId"], {
      unique: true, name: "uq_tenant_erp_connections_tenant_erp"
    });
    await queryInterface.addIndex("tenant_erp_connections", ["tenantId"], {
      name: "idx_tenant_erp_connections_tenant"
    });
    await queryInterface.addIndex("tenant_erp_connections", ["erpConfigId"], {
      name: "idx_tenant_erp_connections_erp"
    });

    // Backfill the existing one-ERP-per-tenant relationship so upgrading
    // does not lose any current assignment. Tenant.erpConfigId remains as
    // a compatibility field for older consumers.
    await queryInterface.sequelize.query(`
      INSERT INTO tenant_erp_connections (tenantId, erpConfigId, isActive, createdAt, updatedAt)
      SELECT id, erpConfigId, 1, NOW(), NOW()
      FROM tenants
      WHERE erpConfigId IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("tenant_erp_connections");
  },
};
