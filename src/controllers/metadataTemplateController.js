// src/controllers/metadataTemplateController.js
const { Op } = require("sequelize");
// PHASE G — all models here are tenant-side; pulled from req.models per
// handler instead of a static legacy import. metadataTemplateService
// now takes `models` as its own first argument too.
const metadataTemplateService = require("../services/metadataTemplateService");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

// ── Create template (auto-creates an empty DRAFT v1) ──────────
const createTemplate = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const models = req.models;
    const { documentTypeId, name, description } = req.body;

    if (!documentTypeId || !name) {
      return res.status(400).json({ success: false, message: "documentTypeId and name are required" });
    }

    const { template, version } = await metadataTemplateService.createTemplate(models, {
      tenantId,
      documentTypeId,
      name: name.trim(),
      description,
      createdBy: req.user.id,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_TEMPLATE,
      action: AUDIT_ACTIONS.METADATA_TEMPLATE_CREATED,
      newValue: { id: template.id, name: template.name, documentTypeId },
      remarks: `Created metadata template "${template.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({ success: true, data: { template, draftVersion: version } });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ success: false, message: "This document type already has a metadata template" });
    }
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// ── List templates for tenant ─────────────────────────────────
const listTemplates = async (req, res) => {
  try {
    const { MetadataTemplate, DocumentType } = req.models;
    const tenantId = req.user.tenantId;
    const { documentTypeId } = req.query;

    const where = { tenantId };
    if (documentTypeId) where.documentTypeId = documentTypeId;

    const templates = await MetadataTemplate.findAll({
      where,
      include: [{ model: DocumentType, attributes: ["id", "name", "categoryId"] }],
      order: [["name", "ASC"]],
    });

    return res.json({ success: true, data: templates });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Get single template with all versions + fields ───────────
const getTemplate = async (req, res) => {
  try {
    const template = await metadataTemplateService.getTemplateWithVersions(req.models, req.params.id, req.user.tenantId);
    if (!template) {
      return res.status(404).json({ success: false, message: "Metadata template not found" });
    }
    return res.json({ success: true, data: template });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Update template (name/description/status) ────────────────
const updateTemplate = async (req, res) => {
  try {
    const { MetadataTemplate } = req.models;
    const tenantId = req.user.tenantId;
    const template = await MetadataTemplate.findOne({ where: { id: req.params.id, tenantId } });
    if (!template) {
      return res.status(404).json({ success: false, message: "Metadata template not found" });
    }

    const oldValue = template.toJSON();
    const { name, description, status } = req.body;
    await template.update({
      name: name !== undefined ? name : template.name,
      description: description !== undefined ? description : template.description,
      status: status !== undefined ? status : template.status,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_TEMPLATE,
      action: AUDIT_ACTIONS.METADATA_TEMPLATE_UPDATED,
      oldValue,
      newValue: template.toJSON(),
      remarks: `Updated metadata template "${template.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: template });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Soft delete template ──────────────────────────────────────
const deleteTemplate = async (req, res) => {
  try {
    const { MetadataTemplate } = req.models;
    const tenantId = req.user.tenantId;
    const template = await MetadataTemplate.findOne({ where: { id: req.params.id, tenantId } });
    if (!template) {
      return res.status(404).json({ success: false, message: "Metadata template not found" });
    }

    await template.update({ status: "INACTIVE" });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_TEMPLATE,
      action: AUDIT_ACTIONS.METADATA_TEMPLATE_DELETED,
      oldValue: { status: "ACTIVE" },
      newValue: { status: "INACTIVE" },
      remarks: `Deleted metadata template "${template.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, message: "Metadata template deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Create a new DRAFT version (optionally cloning latest fields) ─
const createVersion = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { cloneFromLatest = true } = req.body || {};

    const version = await metadataTemplateService.createNewDraftVersion(req.models, {
      templateId: req.params.id,
      tenantId,
      createdBy: req.user.id,
      cloneFromLatest,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_TEMPLATE,
      action: AUDIT_ACTIONS.METADATA_TEMPLATE_VERSION_CREATED,
      newValue: { id: version.id, versionNumber: version.versionNumber },
      remarks: `Created draft version v${version.versionNumber} for template ${req.params.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({ success: true, data: version });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// ── List versions for a template ──────────────────────────────
const listVersions = async (req, res) => {
  try {
    const { MetadataTemplateVersion } = req.models;
    const versions = await MetadataTemplateVersion.findAll({
      where: { metadataTemplateId: req.params.id },
      order: [["versionNumber", "DESC"]],
    });
    return res.json({ success: true, data: versions });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Get a single version with its fields + aliases ────────────
const getVersion = async (req, res) => {
  try {
    const { MetadataTemplate, MetadataTemplateVersion, MetadataField, OcrAlias } = req.models;
    const version = await MetadataTemplateVersion.findOne({
      where: { id: req.params.versionId },
      include: [
        { model: MetadataTemplate },
        {
          model: MetadataField,
          as: "fields",
          include: [{ model: OcrAlias, as: "ocrAliases" }],
        },
      ],
      order: [[{ model: MetadataField, as: "fields" }, "displayOrder", "ASC"]],
    });

    if (!version || version.MetadataTemplate.tenantId !== req.user.tenantId) {
      return res.status(404).json({ success: false, message: "Template version not found" });
    }

    return res.json({ success: true, data: version });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Update version metadata (notes only — fields have their own APIs) ─
const updateVersion = async (req, res) => {
  try {
    const { MetadataTemplate, MetadataTemplateVersion } = req.models;
    const version = await MetadataTemplateVersion.findByPk(req.params.versionId, {
      include: [{ model: MetadataTemplate }],
    });
    if (!version || version.MetadataTemplate.tenantId !== req.user.tenantId) {
      return res.status(404).json({ success: false, message: "Template version not found" });
    }
    if (version.status !== "DRAFT") {
      return res.status(409).json({ success: false, message: "Only DRAFT versions can be edited" });
    }

    const oldValue = version.toJSON();
    await version.update({ notes: req.body.notes !== undefined ? req.body.notes : version.notes });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_TEMPLATE,
      action: AUDIT_ACTIONS.METADATA_TEMPLATE_VERSION_UPDATED,
      oldValue,
      newValue: version.toJSON(),
      remarks: `Updated draft version v${version.versionNumber}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: version });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Publish a DRAFT version ───────────────────────────────────
const publishVersion = async (req, res) => {
  try {
    const version = await metadataTemplateService.publishVersion(req.models, {
      versionId: req.params.versionId,
      tenantId: req.user.tenantId,
      publishedBy: req.user.id,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_TEMPLATE,
      action: AUDIT_ACTIONS.METADATA_TEMPLATE_VERSION_PUBLISHED,
      newValue: { id: version.id, versionNumber: version.versionNumber },
      remarks: `Published version v${version.versionNumber}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: version });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// ── Delete a DRAFT version (published/archived versions are immutable) ─
const deleteVersion = async (req, res) => {
  try {
    const { MetadataTemplate, MetadataTemplateVersion, MetadataField } = req.models;
    const version = await MetadataTemplateVersion.findByPk(req.params.versionId, {
      include: [{ model: MetadataTemplate }],
    });
    if (!version || version.MetadataTemplate.tenantId !== req.user.tenantId) {
      return res.status(404).json({ success: false, message: "Template version not found" });
    }
    if (version.status !== "DRAFT") {
      return res.status(409).json({ success: false, message: "Only DRAFT versions can be deleted" });
    }

    await MetadataField.destroy({ where: { metadataTemplateVersionId: version.id } });
    await version.destroy();

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_TEMPLATE,
      action: AUDIT_ACTIONS.METADATA_TEMPLATE_VERSION_DELETED,
      oldValue: { id: version.id, versionNumber: version.versionNumber },
      remarks: `Deleted draft version v${version.versionNumber}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, message: "Draft version deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Assign a published version to a DocumentType (rollback support) ─
const assignTemplate = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { documentTypeId, metadataTemplateVersionId } = req.body;

    if (!documentTypeId || !metadataTemplateVersionId) {
      return res.status(400).json({ success: false, message: "documentTypeId and metadataTemplateVersionId are required" });
    }

    const assignment = await metadataTemplateService.assignTemplateVersion(req.models, {
      tenantId,
      documentTypeId,
      metadataTemplateVersionId,
      assignedBy: req.user.id,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.METADATA_TEMPLATE,
      action: AUDIT_ACTIONS.METADATA_TEMPLATE_ASSIGNED,
      newValue: { documentTypeId, metadataTemplateVersionId },
      remarks: `Assigned template version ${metadataTemplateVersionId} to document type ${documentTypeId}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: assignment });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// ── Get the currently active/live assignment for a DocumentType ──
const getActiveAssignment = async (req, res) => {
  try {
    const { TemplateAssignment, MetadataTemplateVersion } = req.models;
    const tenantId = req.user.tenantId;
    const { documentTypeId } = req.params;

    const assignment = await TemplateAssignment.findOne({
      where: { tenantId, documentTypeId, status: "ACTIVE" },
      include: [{ model: MetadataTemplateVersion }],
    });

    if (!assignment) {
      return res.json({ success: true, data: null, message: "No template assigned to this document type yet" });
    }

    return res.json({ success: true, data: assignment });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  createVersion,
  listVersions,
  getVersion,
  updateVersion,
  publishVersion,
  deleteVersion,
  assignTemplate,
  getActiveAssignment,
};
