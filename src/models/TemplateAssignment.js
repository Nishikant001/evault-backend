const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Tracks which MetadataTemplateVersion is currently "live" for a
// DocumentType — i.e. which version new uploads will be OCR-mapped
// against. Normally kept in sync automatically whenever a version is
// published, but exposed via its own Assign-Template API so a Tenant
// Admin can explicitly roll back to an older published version without
// re-publishing anything.
const TemplateAssignment = sequelize.define(
  "TemplateAssignment",
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
    },
    metadataTemplateId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "metadata_templates", key: "id" },
    },
    metadataTemplateVersionId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "metadata_template_versions", key: "id" },
    },
    assignedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "template_assignments",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["tenantId", "documentTypeId"],
        name: "unique_assignment_per_tenant_doctype",
      },
    ],
  }
);

module.exports = TemplateAssignment;
