const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// A Tenant can have multiple Company Codes (SAP SD style: Tenant -> Company Code -> Plant ...)
const CompanyCode = sequelize.define(
  "CompanyCode",
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
    code: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "Short unique code within a tenant e.g. 1000, IN01",
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      allowNull: false,
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "company_codes",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["tenantId", "code"],
        name: "unique_company_code_per_tenant",
      },
    ],
  }
);

module.exports = CompanyCode;
