// src/models/tenantModels/CompanyCode.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/CompanyCode.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// A Tenant can have multiple Company Codes (SAP SD style: Tenant -> Company Code -> Plant ...)
module.exports = (sequelize) => sequelize.define(
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

