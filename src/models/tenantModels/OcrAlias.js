// src/models/tenantModels/OcrAlias.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/OcrAlias.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// e.g. field "Invoice Number" -> aliases "Invoice No", "Invoice #", "Inv No",
// "Bill No", "Tax Invoice No". The OCR mapping engine tries the field's own
// label/internalName first, then every alias here, until one matches text
// extracted from the document.
module.exports = (sequelize) => sequelize.define(
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

