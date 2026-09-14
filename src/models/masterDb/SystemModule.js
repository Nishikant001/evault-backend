const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const SystemModule = masterSequelize.define("SystemModule", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  moduleKey: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  moduleName: { type: DataTypes.STRING(150), allowNull: false },
  description: { type: DataTypes.STRING(500), allowNull: true },
  icon: { type: DataTypes.STRING(100), allowNull: true },
  routeKey: { type: DataTypes.STRING(150), allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName: "system_modules",
  timestamps: true,
});

module.exports = SystemModule;
