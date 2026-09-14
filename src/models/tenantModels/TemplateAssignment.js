// src/models/tenantModels/TemplateAssignment.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/TemplateAssignment.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// Tracks which MetadataTemplateVersion is currently "live" for a
// DocumentType — i.e. which version new uploads will be OCR-mapped
// against. Normally kept in sync automatically whenever a version is
// published, but exposed via its own Assign-Template API so a Tenant
// Admin can explicitly roll back to an older published version without
// re-publishing anything.
module.exports = (sequelize) => sequelize.define(
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

