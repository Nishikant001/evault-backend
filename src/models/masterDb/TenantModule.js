const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const TenantModule = masterSequelize.define("TenantModule", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  tenantId: { type: DataTypes.INTEGER, allowNull: false },
  moduleId: { type: DataTypes.INTEGER, allowNull: false },
  isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  assignedBy: { type: DataTypes.INTEGER, allowNull: true },
  assignedAt: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: "tenant_modules",
  timestamps: true,
  indexes: [{ unique: true, fields: ["tenantId", "moduleId"] }],
});

module.exports = TenantModule;
