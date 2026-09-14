// src/models/tenantModels/MetadataField.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/MetadataField.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");
const { FIELD_TYPES } = require("../../constants/metadataFieldTypes");

// One row per Form Builder field (Zoho Creator / WordPress Form Builder
// style). Belongs to exactly one MetadataTemplateVersion — so editing a
// DRAFT version's fields never touches a PUBLISHED version's fields.
module.exports = (sequelize) => sequelize.define(
  "MetadataField",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    metadataTemplateVersionId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "metadata_template_versions", key: "id" },
    },

    // ── Core field builder attributes ─────────────────────
    label: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    internalName: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "camelCase machine key used in mappedMetadata JSON, e.g. invoiceNumber",
    },
    placeholder: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    fieldType: {
      type: DataTypes.ENUM(...Object.values(FIELD_TYPES)),
      allowNull: false,
      defaultValue: FIELD_TYPES.TEXT,
    },
    required: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    defaultValue: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    displayOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    // ── Validation ─────────────────────────────────────────
    // Consolidated JSON bag: { regex, min, max, dateFormat, unique, formula,
    // currencyCode, gstValidation } — kept as one JSON column (like
    // DocumentType.metadataSchema already does elsewhere in this codebase)
    // so new validation kinds never need a migration.
    validation: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {},
    },

    // ── Options for DROPDOWN / RADIO / MULTI_SELECT ───────
    options: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "[{label, value}] — only used by option-based field types",
    },

    helpText: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    tooltip: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    searchable: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    // ── SAP mapping (storage only — no posting) ───────────
    sapField: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "e.g. BKPF-BELNR, BSEG-WRBTR, LIFNR",
    },

    // ── OCR ────────────────────────────────────────────────
    confidenceThreshold: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0.75,
      comment: "0..1 — below this the mapped value is flagged Low confidence",
    },

    readonly: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    hidden: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "metadata_fields",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["metadataTemplateVersionId", "internalName"],
        name: "unique_field_internalname_per_version",
      },
    ],
  }
);

