// src/models/tenantModels/DocumentType.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/DocumentType.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "DocumentType",
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
    categoryId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "categories", key: "id" },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // Which file types are allowed for this doc type
    allowedMimeTypes: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: ["application/pdf", "image/png", "image/jpeg"],
      comment: "e.g. ['application/pdf', 'image/png']",
    },
    // Optional metadata schema the uploader must fill
    metadataSchema: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "Array of field definitions: [{name, label, type, required}]",
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
    },

    // ── SAP Master Synchronization ─────────────────────────
    sapCode: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "SAP DocumentTypeSet code — set by SAP Master Synchronization",
    },
    lastSyncedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "Last time this row was updated by SAP Master Synchronization",
    },
  },
  {
    tableName: "document_types",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["tenantId", "categoryId", "name"],
        name: "unique_doctype_per_tenant_category",
      },
      {
        unique: true,
        fields: ["tenantId", "sapCode"],
        name: "unique_doctype_sapcode_per_tenant",
      },
    ],
  }
);

