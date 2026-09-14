// src/controllers/metadataFieldController.js
// PHASE G — all models here are tenant-side.
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const { FIELD_TYPES, OPTION_BASED_FIELD_TYPES } = require("../constants/metadataFieldTypes");

// Every field mutation must go through a DRAFT version — once a version
// is PUBLISHED/ARCHIVED it is an immutable historical snapshot (old
// documents' DocumentMetadata rows point at it directly).
async function loadEditableVersion(models, versionId, tenantId) {
  const { MetadataTemplateVersion, MetadataTemplate } = models;
  const version = await MetadataTemplateVersion.findByPk(versionId, {
    include: [{ model: MetadataTemplate }],
  });
  if (!version || version.MetadataTemplate.tenantId !== tenantId) {
    const err = new Error("Template version not found");
    err.statusCode = 404;
    throw err;
  }
  if (version.status !== "DRAFT") {
    const err = new Error("Fields can only be modified on a DRAFT version — create a new draft version first");
    err.statusCode = 409;
    throw err;
  }
  return version;
}

// ── Create field ───────────────────────────────────────────────
const createField = async (req, res) => {
  try {
    const { MetadataField } = req.models;
    const tenantId = req.user.tenantId;
    const version = await loadEditableVersion(req.models, req.params.versionId, tenantId);

    const {
      label, internalName, placeholder, fieldType, required, defaultValue,
      displayOrder, validation, options, helpText, tooltip, searchable,
      sapField, confidenceThreshold, readonly, hidden,
    } = req.body;

    if (!label || !internalName || !fieldType) {
      return res.status(400).json({ success: false, message: "label, internalName and fieldType are required" });
    }
    if (!Object.values(FIELD_TYPES).includes(fieldType)) {
      return res.status(400).json({ success: false, message: `Invalid fieldType. Must be one of: ${Object.values(FIELD_TYPES).join(", ")}` });
    }
    if (OPTION_BASED_FIELD_TYPES.includes(fieldType) && (!options || !Array.isArray(options) || !options.length)) {
      return res.status(400).json({ success: false, message: `${fieldType} fields require a non-empty options array` });
    }

    const field = await MetadataField.create({
      metadataTemplateVersionId: version.id,
      label,
      internalName,
      placeholder,
      fieldType,
      required: !!required,
      defaultValue,
      displayOrder: displayOrder ?? 0,
      validation: validation || {},
      options: options || null,
      helpText,
      tooltip,
      searchable: !!searchable,
      sapField,
      confidenceThreshold: confidenceThreshold ?? 0.75,
      readonly: !!readonly,
      hidden: !!hidden,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_FIELD,
      action: AUDIT_ACTIONS.METADATA_FIELD_CREATED,
      newValue: { id: field.id, label, internalName, fieldType },
      remarks: `Added field "${label}" (${internalName}) to version ${version.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({ success: true, data: field });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ success: false, message: "internalName must be unique within this template version" });
    }
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// ── List fields for a version ─────────────────────────────────
const listFields = async (req, res) => {
  try {
    const { MetadataField, OcrAlias } = req.models;
    const fields = await MetadataField.findAll({
      where: { metadataTemplateVersionId: req.params.versionId },
      include: [{ model: OcrAlias, as: "ocrAliases" }],
      order: [["displayOrder", "ASC"]],
    });
    return res.json({ success: true, data: fields });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Update field ───────────────────────────────────────────────
const updateField = async (req, res) => {
  try {
    const { MetadataField, MetadataTemplateVersion, MetadataTemplate } = req.models;
    const tenantId = req.user.tenantId;
    const field = await MetadataField.findByPk(req.params.fieldId, {
      include: [{ model: MetadataTemplateVersion, include: [{ model: MetadataTemplate }] }],
    });
    if (!field || field.MetadataTemplateVersion.MetadataTemplate.tenantId !== tenantId) {
      return res.status(404).json({ success: false, message: "Field not found" });
    }
    if (field.MetadataTemplateVersion.status !== "DRAFT") {
      return res.status(409).json({ success: false, message: "Fields can only be modified on a DRAFT version" });
    }

    const oldValue = field.toJSON();
    const allowedKeys = [
      "label", "placeholder", "fieldType", "required", "defaultValue", "displayOrder",
      "validation", "options", "helpText", "tooltip", "searchable", "sapField",
      "confidenceThreshold", "readonly", "hidden", "status",
    ];
    const updates = {};
    for (const key of allowedKeys) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    await field.update(updates);

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_FIELD,
      action: AUDIT_ACTIONS.METADATA_FIELD_UPDATED,
      oldValue,
      newValue: field.toJSON(),
      remarks: `Updated field "${field.label}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: field });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Delete field (only while its version is DRAFT) ────────────
const deleteField = async (req, res) => {
  try {
    const { MetadataField, MetadataTemplateVersion, MetadataTemplate, OcrAlias } = req.models;
    const tenantId = req.user.tenantId;
    const field = await MetadataField.findByPk(req.params.fieldId, {
      include: [{ model: MetadataTemplateVersion, include: [{ model: MetadataTemplate }] }],
    });
    if (!field || field.MetadataTemplateVersion.MetadataTemplate.tenantId !== tenantId) {
      return res.status(404).json({ success: false, message: "Field not found" });
    }
    if (field.MetadataTemplateVersion.status !== "DRAFT") {
      return res.status(409).json({ success: false, message: "Fields can only be removed from a DRAFT version" });
    }

    const label = field.label;
    await OcrAlias.destroy({ where: { metadataFieldId: field.id } });
    await field.destroy();

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_FIELD,
      action: AUDIT_ACTIONS.METADATA_FIELD_DELETED,
      oldValue: { id: req.params.fieldId, label },
      remarks: `Deleted field "${label}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, message: "Field deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Bulk reorder (drag-and-drop) ──────────────────────────────
// body: { order: [{ fieldId, displayOrder }, ...] }
const reorderFields = async (req, res) => {
  try {
    const { MetadataField } = req.models;
    const tenantId = req.user.tenantId;
    const version = await loadEditableVersion(req.models, req.params.versionId, tenantId);
    const { order } = req.body;

    if (!Array.isArray(order) || !order.length) {
      return res.status(400).json({ success: false, message: "order must be a non-empty array of { fieldId, displayOrder }" });
    }

    await Promise.all(
      order.map(({ fieldId, displayOrder }) =>
        MetadataField.update(
          { displayOrder },
          { where: { id: fieldId, metadataTemplateVersionId: version.id } }
        )
      )
    );

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_FIELD,
      action: AUDIT_ACTIONS.METADATA_FIELD_REORDERED,
      newValue: { versionId: version.id, order },
      remarks: `Reordered fields for version ${version.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    const fields = await MetadataField.findAll({ where: { metadataTemplateVersionId: version.id }, order: [["displayOrder", "ASC"]] });
    return res.json({ success: true, data: fields });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// ── OCR aliases ────────────────────────────────────────────────
const createAlias = async (req, res) => {
  try {
    const { MetadataField, MetadataTemplateVersion, MetadataTemplate, OcrAlias } = req.models;
    const tenantId = req.user.tenantId;
    const { alias } = req.body;
    if (!alias) {
      return res.status(400).json({ success: false, message: "alias is required" });
    }

    const field = await MetadataField.findByPk(req.params.fieldId, {
      include: [{ model: MetadataTemplateVersion, include: [{ model: MetadataTemplate }] }],
    });
    if (!field || field.MetadataTemplateVersion.MetadataTemplate.tenantId !== tenantId) {
      return res.status(404).json({ success: false, message: "Field not found" });
    }

    const aliasRow = await OcrAlias.create({ metadataFieldId: field.id, alias: alias.trim() });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_FIELD,
      action: AUDIT_ACTIONS.OCR_ALIAS_CREATED,
      newValue: { fieldId: field.id, alias: aliasRow.alias },
      remarks: `Added OCR alias "${aliasRow.alias}" for field "${field.label}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({ success: true, data: aliasRow });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ success: false, message: "This alias already exists for this field" });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

const listAliases = async (req, res) => {
  try {
    const { OcrAlias } = req.models;
    const aliases = await OcrAlias.findAll({ where: { metadataFieldId: req.params.fieldId } });
    return res.json({ success: true, data: aliases });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const deleteAlias = async (req, res) => {
  try {
    const { MetadataField, MetadataTemplateVersion, MetadataTemplate, OcrAlias } = req.models;
    const tenantId = req.user.tenantId;
    const aliasRow = await OcrAlias.findByPk(req.params.aliasId, {
      include: [{ model: MetadataField, include: [{ model: MetadataTemplateVersion, include: [{ model: MetadataTemplate }] }] }],
    });
    if (!aliasRow || aliasRow.MetadataField.MetadataTemplateVersion.MetadataTemplate.tenantId !== tenantId) {
      return res.status(404).json({ success: false, message: "Alias not found" });
    }

    const aliasText = aliasRow.alias;
    await aliasRow.destroy();

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_FIELD,
      action: AUDIT_ACTIONS.OCR_ALIAS_DELETED,
      oldValue: { alias: aliasText },
      remarks: `Removed OCR alias "${aliasText}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, message: "Alias deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createField,
  listFields,
  updateField,
  deleteField,
  reorderFields,
  createAlias,
  listAliases,
  deleteAlias,
};
