const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Each version is an immutable-once-published snapshot of a template's
// field configuration. Old documents remember the version they were
// mapped against (DocumentMetadata.metadataTemplateVersionId), so a new
// published version never rewrites the meaning of historical data.
const MetadataTemplateVersion = sequelize.define(
  "MetadataTemplateVersion",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    metadataTemplateId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "metadata_templates", key: "id" },
    },
    versionNumber: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("DRAFT", "PUBLISHED", "ARCHIVED"),
      allowNull: false,
      defaultValue: "DRAFT",
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    publishedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    publishedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
  },
  {
    tableName: "metadata_template_versions",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["metadataTemplateId", "versionNumber"],
        name: "unique_version_per_template",
      },
    ],
  }
);

module.exports = MetadataTemplateVersion;
