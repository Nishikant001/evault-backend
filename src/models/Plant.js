const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// A Company Code can have multiple Plants (SAP SD style: Company Code -> Plant -> Department ...)
const Plant = sequelize.define(
  "Plant",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // Denormalized tenantId (same convention as Category/DocumentType/Document)
    // to keep tenant-scoped queries fast without always joining through CompanyCode.
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "tenants", key: "id" },
    },
    companyCodeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "company_codes", key: "id" },
    },
    code: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "Short unique code within a company code e.g. P001, BBSR1",
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
    tableName: "plants",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["companyCodeId", "code"],
        name: "unique_plant_code_per_company_code",
      },
    ],
  }
);

module.exports = Plant;
