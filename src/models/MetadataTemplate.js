const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// A MetadataTemplate is the "container" a Tenant Admin creates for exactly
// one DocumentType (Finance > Purchase > Invoice -> "Invoice Template").
// The actual fields live on its versions (MetadataTemplateVersion ->
// MetadataField), so old documents can keep using an older version's
// field set while new uploads use whatever version is currently published.
const MetadataTemplate = sequelize.define(
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
      references: { model: "tenants", key: "id" },
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

module.exports = MetadataTemplate;
