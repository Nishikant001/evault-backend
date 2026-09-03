// src/models/tenantModels/MetadataTemplate.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/MetadataTemplate.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// A MetadataTemplate is the "container" a Tenant Admin creates for exactly
// one DocumentType (Finance > Purchase > Invoice -> "Invoice Template").
// The actual fields live on its versions (MetadataTemplateVersion ->
// MetadataField), so old documents can keep using an older version's
// field set while new uploads use whatever version is currently published.
module.exports = (sequelize) => sequelize.define(
  "MetadataTemplate",
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
    documentTypeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "document_types", key: "id" },
      comment: "Every DocumentType has at most one MetadataTemplate",
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
      defaultValue: "ACTIVE",
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
  },
  {
    tableName: "metadata_templates",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["tenantId", "documentTypeId"],
        name: "unique_template_per_tenant_doctype",
      },
    ],
  }
);

