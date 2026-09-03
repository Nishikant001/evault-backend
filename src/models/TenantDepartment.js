const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Pivot table: Admin decides which departments a tenant can use
const TenantDepartment = sequelize.define(
  "TenantDepartment",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "tenants", key: "id" },
    },
    departmentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "departments", key: "id" },
    },
    assignedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "userId of the Admin/SuperAdmin who made this assignment",
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "tenant_departments",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["tenantId", "departmentId"],
      },
    ],
  }
);

module.exports = TenantDepartment;