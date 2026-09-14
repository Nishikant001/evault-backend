// src/services/dynamicOcrMappingService.js
//
// The heart of the "NO STATIC FIELD LIST" requirement: given the raw OCR
// text for a document and the Tenant Admin's configured MetadataTemplate
// (fields + OCR aliases), populate every field dynamically and return a
// confidence score per field. Completely additive/optional — if a
// DocumentType has no published template, `mapDocument` is a safe no-op
// and the existing static ocrService.parseFields() pipeline is untouched.

const OcrService = require("./ocrService");
const metadataTemplateService = require("./metadataTemplateService");
const { validateMetadata, evaluateFormula } = require("./metadataValidationService");
const { CONFIDENCE_LEVELS, NON_OCR_FIELD_TYPES, FIELD_TYPES } = require("../constants/metadataFieldTypes");
// PHASE G — DocumentMetadata is tenant-side; resolved per-call via tenantId (already a mapDocument param) instead of a static legacy import.
const { getTenantConnection } = require("./tenantConnectionManager");

function confidenceLabel(score, threshold) {
  if (score >= Math.max(threshold, 0.85)) return CONFIDENCE_LEVELS.HIGH;
  if (score >= threshold) return CONFIDENCE_LEVELS.MID;
  return CONFIDENCE_LEVELS.LOW;
}

function candidateAliasesForField(field) {
  const aliases = [field.label, field.internalName];
  if (field.ocrAliases && field.ocrAliases.length) {
    for (const a of field.ocrAliases) {
      if (a.status !== "INACTIVE") aliases.push(a.alias);
    }
  }
  return Array.from(new Set(aliases.filter(Boolean)));
}

/**
 * Map a document's OCR text against the active (assigned) template
 * version for its DocumentType, and persist the result to DocumentMetadata.
 *
 * @param {object} params
 * @param {number} params.documentId
 * @param {number} params.tenantId
 * @param {number} params.documentTypeId
 * @param {string} params.extractedText   - raw OCR text (from ocrService.process)
 * @param {object} [params.legacyFields]  - the old static ocrService.parseFields() output, kept for the rawOcrJson audit trail
 * @returns {Promise<object|null>} the created/updated DocumentMetadata row, or null if no template is assigned
 */
async function mapDocument({ documentId, tenantId, documentTypeId, extractedText, legacyFields }) {
  const { models } = await getTenantConnection(tenantId);
  const { DocumentMetadata } = models;
  const version = await metadataTemplateService.resolveActiveVersionForDocumentType(models, tenantId, documentTypeId);

  if (!version) {
    // No Tenant Admin-configured template yet for this DocumentType —
    // dynamic mapping is skipped entirely, old behavior stands.
    return null;
  }

  const fields = (version.fields || []).slice().sort((a, b) => a.displayOrder - b.displayOrder);
  const mappedMetadata = {};
  const confidence = {};
  const genericPairs = OcrService.extractGenericPairs(extractedText);

  for (const field of fields) {
    if (NON_OCR_FIELD_TYPES.includes(field.fieldType)) {
      // AUTO_NUMBER / FORMULA / HIDDEN / SIGNATURE / FILE / IMAGE are never
      // OCR-populated; leave for defaultValue / formula evaluation / manual entry.
      if (field.defaultValue !== undefined && field.defaultValue !== null && field.defaultValue !== "") {
        mappedMetadata[field.internalName] = field.defaultValue;
        confidence[field.internalName] = { confidence: CONFIDENCE_LEVELS.HIGH, score: 1, matchedAlias: null };
      }
      continue;
    }

    const aliases = candidateAliasesForField(field);
    const found = OcrService.findValueForAliases(extractedText, aliases);

    if (found) {
      mappedMetadata[field.internalName] = found.value;
      // Simple heuristic score: exact alias/label match on a clean line = 0.9,
      // matched via a configured alias (not the field's own label) = 0.8.
      const score = found.matchedAlias.toLowerCase() === field.label.toLowerCase() ? 0.9 : 0.8;
      confidence[field.internalName] = {
        confidence: confidenceLabel(score, field.confidenceThreshold),
        score,
        matchedAlias: found.matchedAlias,
      };
    } else {
      mappedMetadata[field.internalName] = field.defaultValue || null;
      confidence[field.internalName] = { confidence: CONFIDENCE_LEVELS.LOW, score: 0, matchedAlias: null };
    }
  }

  // FORMULA fields are derived, not OCR-mapped — compute them last so they
  // can reference any other field already populated above.
  for (const field of fields) {
    if (field.fieldType !== FIELD_TYPES.FORMULA) continue;
    const formula = field.validation && field.validation.formula;
    if (!formula) continue;
    try {
      const computed = evaluateFormula(formula, mappedMetadata);
      mappedMetadata[field.internalName] = computed;
      confidence[field.internalName] = { confidence: CONFIDENCE_LEVELS.HIGH, score: 1, matchedAlias: null };
    } catch (err) {
      confidence[field.internalName] = { confidence: CONFIDENCE_LEVELS.LOW, score: 0, matchedAlias: null };
    }
  }

  const { errors } = validateMetadata(fields, mappedMetadata);

  const [record] = await DocumentMetadata.upsert(
    {
      documentId,
      metadataTemplateVersionId: version.id,
      rawOcrJson: { extractedText, genericPairs, legacyFields: legacyFields || null },
      mappedMetadataJson: mappedMetadata,
      confidenceJson: confidence,
      validationErrorsJson: errors,
      correctionHistory: [],
      status: "PENDING_REVIEW",
    },
    { returning: true }
  );

  return record;
}

module.exports = { mapDocument, candidateAliasesForField };
