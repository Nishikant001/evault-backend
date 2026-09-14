const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// e.g. field "Invoice Number" -> aliases "Invoice No", "Invoice #", "Inv No",
// "Bill No", "Tax Invoice No". The OCR mapping engine tries the field's own
// label/internalName first, then every alias here, until one matches text
// extracted from the document.
const OcrAlias = sequelize.define(
  "OcrAlias",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    metadataFieldId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "metadata_fields", key: "id" },
    },
    alias: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "ocr_aliases",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["metadataFieldId", "alias"],
        name: "unique_alias_per_field",
      },
    ],
  }
);

module.exports = OcrAlias;
