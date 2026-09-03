const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const TenantErpConnection = masterSequelize.define(
  "TenantErpConnection",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    tenantId: { type: DataTypes.INTEGER, allowNull: false },
    erpConfigId: { type: DataTypes.INTEGER, allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
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
