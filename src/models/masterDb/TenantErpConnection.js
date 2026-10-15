const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const TenantErpConnection = masterSequelize.define(
  "TenantErpConnection",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    tenantId: { type: DataTypes.INTEGER, allowNull: false },
    erpConfigId: { type: DataTypes.INTEGER, allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // PHASE 3 (multi-ERP sync management) — at most one active connection
    // per tenant should have isDefault=true; enforced in
    // tenantErpConnectionService.setDefaultConnection(), not at the DB
    // constraint level (matches this project's existing convention of
    // application-level invariants over DB-level ones for this table).
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: "tenant_erp_connections",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["tenantId", "erpConfigId"] },
      { fields: ["tenantId"] },
      { fields: ["erpConfigId"] },
    ],
  }
);

module.exports = TenantErpConnection;
