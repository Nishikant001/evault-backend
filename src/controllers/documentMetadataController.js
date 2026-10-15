// src/controllers/documentMetadataController.js
// PHASE G — all models here are tenant-side.
const userAssignmentService = require("../services/userAssignmentService");
const { validateMetadata, checkDuplicates, evaluateFormula } = require("../services/metadataValidationService");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

async function loadAccessibleDocument(req) {
  const { Document } = req.models;
  const { id } = req.params;
  const tenantId = req.user.tenantId;

  const document = await Document.findOne({ where: { id, tenantId, status: "ACTIVE" } });
  if (!document) {
    const err = new Error("Document not found");
    err.statusCode = 404;
    throw err;
  }

  const allowed = await userAssignmentService.hasDocumentTypeAccess(
    req.models, tenantId, req.user.id, req.user.role, document.documentTypeId
  );
  if (!allowed) {
    const err = new Error("You do not have access to this document");
    err.statusCode = 403;
    throw err;
  }

  return document;
}

async function loadFieldsForVersion(models, versionId) {
  if (!versionId) return [];
  const { MetadataField, OcrAlias } = models;
  // ACTIVE only: identical to the set the OCR mapper maps, so Review/validation/save agree.
  return MetadataField.findAll({
    where: { metadataTemplateVersionId: versionId, status: "ACTIVE" },
    include: [{ model: OcrAlias, as: "ocrAliases" }],
    order: [["displayOrder", "ASC"]],
  });
}

// ── Get a document's dynamic metadata (raw OCR + mapped + confidence) ─
const getDocumentMetadata = async (req, res) => {
  try {
    const { DocumentMetadata, MetadataTemplateVersion } = req.models;
    const document = await loadAccessibleDocument(req);

    const record = await DocumentMetadata.findOne({
      where: { documentId: document.id },
      include: [{ model: MetadataTemplateVersion }],
    });

    if (!record) {
      return res.json({
        success: true,
        data: null,
        message: "No dynamic metadata template was assigned to this document's type at upload time",
      });
    }

    const fields = await loadFieldsForVersion(req.models, record.metadataTemplateVersionId);

    // The document stays bound to the template version it was mapped with. If a
    // newer version has since been assigned to the document type, flag it (do not
    // silently switch) so the UI can tell the user.
    let templateVersionStale = false; let activeTemplateVersionId = null;
    try {
      const active = await require("../services/metadataTemplateService").resolveActiveVersionForDocumentType(req.models, req.user.tenantId, document.documentTypeId);
      activeTemplateVersionId = active ? active.id : null;
      templateVersionStale = !!active && active.id !== record.metadataTemplateVersionId;
    } catch (_) { /* informational only */ }
    const summary = (record.rawOcrJson && record.rawOcrJson.ocrSummary) || null;

    return res.json({
      success: true,
      data: {
        documentId: document.id,
        metadataTemplateVersionId: record.metadataTemplateVersionId,
        activeTemplateVersionId,
        templateVersionStale,
        ocrEngine: summary ? { used: summary.engineUsed || null, requested: summary.engineRequested || null, fallbackUsed: !!summary.fallbackUsed, status: summary.status || null, providerError: summary.providerError || null, warnings: summary.warnings || [] } : null,
        rawOcr: record.rawOcrJson,
        mappedMetadata: record.mappedMetadataJson,
        confidence: record.confidenceJson,
        validationErrors: record.validationErrorsJson,
        correctionHistory: record.correctionHistory,
        status: record.status,
        fields,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// ── Manual correction: apply user-supplied field values ────────
// body: { values: { [internalName]: newValue }, confirm?: boolean }
const correctDocumentMetadata = async (req, res) => {
  try {
    const { DocumentMetadata } = req.models;
    const document = await loadAccessibleDocument(req);
    const { values, confirm } = req.body;

    if (!values || typeof values !== "object") {
      return res.status(400).json({ success: false, message: "values object is required" });
    }

    const record = await DocumentMetadata.findOne({ where: { documentId: document.id } });
    if (!record) {
      return res.status(404).json({ success: false, message: "No dynamic metadata exists for this document" });
    }

    const fields = await loadFieldsForVersion(req.models, record.metadataTemplateVersionId);
    const fieldByInternalName = new Map(fields.map((f) => [f.internalName, f]));

    const mergedMetadata = { ...(record.mappedMetadataJson || {}) };
    const history = Array.isArray(record.correctionHistory) ? [...record.correctionHistory] : [];
    const confidenceJson = { ...(record.confidenceJson || {}) };
    const now = new Date();

    for (const [internalName, newValue] of Object.entries(values)) {
      const field = fieldByInternalName.get(internalName);
      if (!field) continue; // ignore unknown keys — no static/dynamic mismatch crashes
      if (field.readonly) continue; // readonly fields cannot be manually corrected

      const oldValue = mergedMetadata[internalName];
      if (oldValue === newValue) continue;

      history.push({
        internalName,
        oldValue: oldValue ?? null,
        newValue: newValue ?? null,
        correctedBy: req.user.id,
        correctedAt: now,
      });
      mergedMetadata[internalName] = newValue;
      // Provenance: keep the OCR evidence, mark the value as user-edited.
      confidenceJson[internalName] = { ...(confidenceJson[internalName] || {}), status: "MANUALLY_EDITED", manuallyEdited: true, editedBy: req.user.id, editedAt: now };
    }

    // FORMULA fields are derived — recompute them from whatever values
    // just changed, so e.g. correcting quantity/unitPrice keeps a
    // "Net = quantity * unitPrice" field in sync.
    for (const field of fields) {
      if (field.fieldType !== "FORMULA") continue;
      const formula = field.validation && field.validation.formula;
      if (!formula) continue;
      try {
        mergedMetadata[field.internalName] = evaluateFormula(formula, mergedMetadata);
      } catch {
        // leave prior value in place; validateMetadata below will surface the formula error
      }
    }

    const { errors } = validateMetadata(fields, mergedMetadata);
    const duplicates = await checkDuplicates(req.models, {
      fields,
      metadataValues: mergedMetadata,
      tenantId: req.user.tenantId,
      documentTypeId: document.documentTypeId,
      excludeDocumentId: document.id,
    });
    for (const [internalName, message] of Object.entries(duplicates)) {
      errors[internalName] = [...(errors[internalName] || []), message];
    }

    await record.update({
      mappedMetadataJson: mergedMetadata,
      confidenceJson,
      validationErrorsJson: errors,
      correctionHistory: history,
      status: confirm && Object.keys(errors).length === 0 ? "CONFIRMED" : record.status,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT_METADATA,
      action: AUDIT_ACTIONS.DOCUMENT_METADATA_CORRECTED,
      documentId: document.id,
      newValue: { corrected: Object.keys(values) },
      remarks: `Corrected metadata fields [${Object.keys(values).join(", ")}] on document ${document.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({
      success: true,
      data: {
        mappedMetadata: mergedMetadata,
        validationErrors: errors,
        valid: Object.keys(errors).length === 0,
        status: record.status,
        correctionHistory: history,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// ── Validate a metadata payload against the active template, without saving ─
const validateDocumentMetadata = async (req, res) => {
  try {
    const { DocumentMetadata } = req.models;
    const document = await loadAccessibleDocument(req);
    const record = await DocumentMetadata.findOne({ where: { documentId: document.id } });

    if (!record) {
      return res.json({ success: true, data: { valid: true, errors: {} }, message: "No template assigned — nothing to validate" });
    }

    const fields = await loadFieldsForVersion(req.models, record.metadataTemplateVersionId);
    const values = req.body.values || record.mappedMetadataJson || {};

    const { valid, errors } = validateMetadata(fields, values);
    const duplicates = await checkDuplicates(req.models, {
      fields,
      metadataValues: values,
      tenantId: req.user.tenantId,
      documentTypeId: document.documentTypeId,
      excludeDocumentId: document.id,
    });
    for (const [internalName, message] of Object.entries(duplicates)) {
      errors[internalName] = [...(errors[internalName] || []), message];
    }

    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT_METADATA,
      action: AUDIT_ACTIONS.DOCUMENT_METADATA_VALIDATED,
      documentId: document.id,
      remarks: `Validated metadata for document ${document.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: { valid: valid && !Object.keys(duplicates).length, errors } });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getDocumentMetadata,
  correctDocumentMetadata,
  validateDocumentMetadata,
};
