const { DataTypes } = require("sequelize");

// PHASE 3 (multi-ERP sync management) — tenant_erp_connections was created
// in Phase 1 (20260830000003-create-tenant-erp-connections.js) without a
// per-connection default flag; Phase 2's sync resolution therefore only
// had "exactly one active SAP connection" as an unambiguous case. This
// migration adds that flag so a tenant with several active ERP
// connections can mark exactly one as default.
module.exports = {
  async up(queryInterface) {
    await queryInterface.addColumn("tenant_erp_connections", "isDefault", {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    // Backfill: for every tenant that already has exactly one active
    // connection (the overwhelming majority right after Phase 1's
    // backfill), mark it default so existing single-ERP tenants get a
    // real default row instead of relying solely on the "only one active
    // connection" fallback. Tenants with 0 or 2+ active connections are
    // left with no default — Phase 3's resolution order still falls back
    // safely for the former, and the latter must pick one explicitly via
    // "Set Default" (see PART 2 of the brief).
    await queryInterface.sequelize.query(`
      UPDATE tenant_erp_connections tec
      JOIN (
        SELECT tenantId
        FROM tenant_erp_connections
        WHERE isActive = 1
        GROUP BY tenantId
        HAVING COUNT(*) = 1
      ) single_active ON single_active.tenantId = tec.tenantId
      SET tec.isDefault = 1
      WHERE tec.isActive = 1
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("tenant_erp_connections", "isDefault");
  },
};
