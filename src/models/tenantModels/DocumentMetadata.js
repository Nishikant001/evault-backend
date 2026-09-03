// src/models/tenantModels/DocumentMetadata.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/DocumentMetadata.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// One row per Document. This is the dynamic replacement for the old
// hardcoded Document.ocrMetadata shape — Document.ocrMetadata is left
// untouched for backward compatibility, and this table carries the new
// template-driven pipeline: raw OCR -> mapped fields -> confidence ->
// manual corrections.
module.exports = (sequelize) => sequelize.define(
  "DocumentMetadata",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    documentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: "documents", key: "id" },
    },
    metadataTemplateVersionId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "metadata_template_versions", key: "id" },
      comment: "null when no template was assigned to the DocumentType at upload time",
    },

    rawOcrJson: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "Full extracted OCR text + generic key/value pairs, verbatim",
    },
    mappedMetadataJson: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {},
      comment: "{ [internalName]: value } — after alias mapping + manual corrections",
    },
    confidenceJson: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {},
      comment: "{ [internalName]: { confidence: 'High'|'Mid'|'Low', score, matchedAlias } }",
    },
    validationErrorsJson: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {},
      comment: "{ [internalName]: [errorMessages] } — last computed validation result",
    },
    correctionHistory: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: [],
      comment: "[{ internalName, oldValue, newValue, correctedBy, correctedAt }]",
    },
    status: {
      type: DataTypes.ENUM("PENDING_REVIEW", "CONFIRMED"),
      allowNull: false,
      defaultValue: "PENDING_REVIEW",
    },
  },
  {
    tableName: "document_metadata",
    timestamps: true,
  }
);

