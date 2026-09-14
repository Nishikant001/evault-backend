// src/services/metadataTemplateService.js
//
// Reusable service layer for the Dynamic Metadata Template Engine / Form
// Builder. Controllers stay thin and call into here; this file owns all
// the cross-model logic (versioning rules, publish/assign flow, and
// resolving "which template version applies to this document right now").
//
// PHASE G — every exported function now takes `models` (the CALLING
// tenant's own model set, from req.models / getTenantConnection) as its
// first argument, instead of a static top-level `require("../models")`
// import against the legacy shared DB. The transaction used internally
// is `models.MetadataTemplate.sequelize.transaction(...)` — a model's
// own `.sequelize` always points at the connection it was defined on, so
// this is guaranteed to be the SAME tenant connection the rest of the
// function is already querying, with no separate parameter needed.

const { TEMPLATE_VERSION_STATUS } = require("../constants/metadataFieldTypes");

// ── Template ─────────────────────────────────────────────────
async function createTemplate(models, { tenantId, documentTypeId, name, description, createdBy }) {
  const { MetadataTemplate, MetadataTemplateVersion, DocumentType } = models;
  const docType = await DocumentType.findOne({ where: { id: documentTypeId, tenantId, status: "ACTIVE" } });
  if (!docType) {
    const err = new Error("Document type not found or does not belong to your tenant");
    err.statusCode = 404;
    throw err;
  }

  return MetadataTemplate.sequelize.transaction(async (t) => {
    const template = await MetadataTemplate.create(
      { tenantId, documentTypeId, name, description, createdBy },
      { transaction: t }
    );

    // Every new template starts life with an empty DRAFT v1 — the Tenant
    // Admin then adds fields to it via the Form Builder APIs.
    const version = await MetadataTemplateVersion.create(
      {
        metadataTemplateId: template.id,
        versionNumber: 1,
        status: TEMPLATE_VERSION_STATUS.DRAFT,
        createdBy,
      },
      { transaction: t }
    );

    return { template, version };
  });
}

async function getTemplateWithVersions(models, templateId, tenantId) {
  const { MetadataTemplate, MetadataTemplateVersion, MetadataField, OcrAlias, DocumentType } = models;
  return MetadataTemplate.findOne({
    where: { id: templateId, tenantId },
    include: [
      { model: DocumentType, attributes: ["id", "name", "categoryId"] },
      {
        model: MetadataTemplateVersion,
        as: "versions",
        include: [{ model: MetadataField, as: "fields", include: [{ model: OcrAlias, as: "ocrAliases" }] }],
      },
    ],
    order: [[{ model: MetadataTemplateVersion, as: "versions" }, "versionNumber", "DESC"]],
  });
}

// ── Version ──────────────────────────────────────────────────
async function createNewDraftVersion(models, { templateId, tenantId, createdBy, cloneFromLatest = true }) {
  const { MetadataTemplate, MetadataTemplateVersion, MetadataField, OcrAlias } = models;
  const template = await MetadataTemplate.findOne({ where: { id: templateId, tenantId } });
  if (!template) {
    const err = new Error("Metadata template not found");
    err.statusCode = 404;
    throw err;
  }

  const latest = await MetadataTemplateVersion.findOne({
    where: { metadataTemplateId: templateId },
    order: [["versionNumber", "DESC"]],
    include: [{ model: MetadataField, as: "fields", include: [{ model: OcrAlias, as: "ocrAliases" }] }],
  });

  const nextVersionNumber = latest ? latest.versionNumber + 1 : 1;

  return MetadataTemplate.sequelize.transaction(async (t) => {
    const newVersion = await MetadataTemplateVersion.create(
      {
        metadataTemplateId: templateId,
        versionNumber: nextVersionNumber,
        status: TEMPLATE_VERSION_STATUS.DRAFT,
        createdBy,
      },
      { transaction: t }
    );

    if (cloneFromLatest && latest && latest.fields && latest.fields.length) {
      for (const field of latest.fields) {
        const plain = field.toJSON();
        const clonedField = await MetadataField.create(
          {
            metadataTemplateVersionId: newVersion.id,
            label: plain.label,
            internalName: plain.internalName,
            placeholder: plain.placeholder,
            fieldType: plain.fieldType,
            required: plain.required,
            defaultValue: plain.defaultValue,
            displayOrder: plain.displayOrder,
            validation: plain.validation,
            options: plain.options,
            helpText: plain.helpText,
            tooltip: plain.tooltip,
            searchable: plain.searchable,
            sapField: plain.sapField,
            confidenceThreshold: plain.confidenceThreshold,
            readonly: plain.readonly,
            hidden: plain.hidden,
            status: plain.status,
          },
          { transaction: t }
        );

        if (plain.ocrAliases && plain.ocrAliases.length) {
          await OcrAlias.bulkCreate(
            plain.ocrAliases.map((a) => ({ metadataFieldId: clonedField.id, alias: a.alias, status: a.status })),
            { transaction: t }
          );
        }
      }
    }

    return newVersion;
  });
}

async function publishVersion(models, { versionId, tenantId, publishedBy }) {
  const { MetadataTemplate, MetadataTemplateVersion, MetadataField, TemplateAssignment } = models;
  const version = await MetadataTemplateVersion.findByPk(versionId, {
    include: [{ model: MetadataTemplate }],
  });
  if (!version || version.MetadataTemplate.tenantId !== tenantId) {
    const err = new Error("Template version not found");
    err.statusCode = 404;
    throw err;
  }

  const fieldCount = await MetadataField.count({ where: { metadataTemplateVersionId: versionId, status: "ACTIVE" } });
  if (!fieldCount) {
    const err = new Error("Cannot publish a template version with no fields");
    err.statusCode = 400;
    throw err;
  }

  return MetadataTemplate.sequelize.transaction(async (t) => {
    // Archive whichever version is currently published for this template
    await MetadataTemplateVersion.update(
      { status: TEMPLATE_VERSION_STATUS.ARCHIVED },
      {
        where: {
          metadataTemplateId: version.metadataTemplateId,
          status: TEMPLATE_VERSION_STATUS.PUBLISHED,
        },
        transaction: t,
      }
    );

    await version.update(
      { status: TEMPLATE_VERSION_STATUS.PUBLISHED, publishedAt: new Date(), publishedBy },
      { transaction: t }
    );

    // Auto-assign: new uploads for this DocumentType now use this version.
    // Old documents keep whatever metadataTemplateVersionId is already
    // stored on their DocumentMetadata row, so this never rewrites history.
    const template = version.MetadataTemplate;
    await TemplateAssignment.upsert(
      {
        tenantId,
        documentTypeId: template.documentTypeId,
        metadataTemplateId: template.id,
        metadataTemplateVersionId: version.id,
        assignedBy: publishedBy,
        status: "ACTIVE",
      },
      { transaction: t }
    );

    return version;
  });
}

async function assignTemplateVersion(models, { tenantId, documentTypeId, metadataTemplateVersionId, assignedBy }) {
  const { MetadataTemplate, MetadataTemplateVersion, TemplateAssignment } = models;
  const version = await MetadataTemplateVersion.findOne({
    where: { id: metadataTemplateVersionId, status: TEMPLATE_VERSION_STATUS.PUBLISHED },
    include: [{ model: MetadataTemplate }],
  });
  if (!version || version.MetadataTemplate.tenantId !== tenantId || version.MetadataTemplate.documentTypeId !== Number(documentTypeId)) {
    const err = new Error("A published version of this document type's template must be selected");
    err.statusCode = 400;
    throw err;
  }

  const [assignment] = await TemplateAssignment.upsert(
    {
      tenantId,
      documentTypeId,
      metadataTemplateId: version.metadataTemplateId,
      metadataTemplateVersionId,
      assignedBy,
      status: "ACTIVE",
    },
    { returning: true }
  );

  return assignment;
}

// Resolves the version that should be used to OCR-map a NEW upload for a
// given documentTypeId. Returns null when no template has been published
// yet (dynamic mapping is then simply skipped — fully backward compatible
// with the old static OCR flow).
async function resolveActiveVersionForDocumentType(models, tenantId, documentTypeId) {
  const { TemplateAssignment, MetadataTemplateVersion, MetadataField, OcrAlias } = models;
  const assignment = await TemplateAssignment.findOne({
    where: { tenantId, documentTypeId, status: "ACTIVE" },
  });
  if (!assignment) return null;

  return MetadataTemplateVersion.findOne({
    where: { id: assignment.metadataTemplateVersionId, status: TEMPLATE_VERSION_STATUS.PUBLISHED },
    include: [{ model: MetadataField, as: "fields", include: [{ model: OcrAlias, as: "ocrAliases" }], where: { status: "ACTIVE" }, required: false }],
    order: [[{ model: MetadataField, as: "fields" }, "displayOrder", "ASC"]],
  });
}

module.exports = {
  createTemplate,
  getTemplateWithVersions,
  createNewDraftVersion,
  publishVersion,
  assignTemplateVersion,
  resolveActiveVersionForDocumentType,
};
