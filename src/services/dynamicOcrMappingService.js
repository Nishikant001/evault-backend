// Dynamic, tenant-template-driven OCR metadata mapping.
// Keeps the existing database contract and augments matching with next-line
// support, field-type checks, OCR confidence, and candidate diagnostics.
const OcrService = require("./ocrService");
const metadataTemplateService = require("./metadataTemplateService");
const { validateMetadata, evaluateFormula } = require("./metadataValidationService");
const { CONFIDENCE_LEVELS, NON_OCR_FIELD_TYPES, FIELD_TYPES } = require("../constants/metadataFieldTypes");
const { getTenantConnection } = require("./tenantConnectionManager");

function confidenceLabel(score, threshold) {
  const min = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.6;
  if (score >= Math.max(min, 0.85)) return CONFIDENCE_LEVELS.HIGH;
  if (score >= min) return CONFIDENCE_LEVELS.MID;
  return CONFIDENCE_LEVELS.LOW;
}

function candidateAliasesForField(field) {
  const aliases = [field.label, field.internalName];
  for (const alias of field.ocrAliases || []) {
    if (alias && alias.status !== "INACTIVE") aliases.push(alias.alias);
  }
  return Array.from(new Set(aliases.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())));
}

function validateCandidate(field, value) {
  const text = String(value || "").trim();
  if (!text) return { valid: false, score: 0 };
  const type = String(field.fieldType || "TEXT").toUpperCase();
  const aliases = [field.label, field.internalName, ...(field.ocrAliases || []).map((item) => item && item.alias)].filter(Boolean).join(" ").toLowerCase();

  if (type === FIELD_TYPES.DATE) {
    const dateMatch = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/.test(text);
    return { valid: dateMatch, score: dateMatch ? 1 : 0.1 };
  }
  if (type === FIELD_TYPES.NUMBER || type === FIELD_TYPES.CURRENCY) {
    const numeric = text.replace(/[₹$€£,\s]/g, "");
    const valid = /^-?\d+(\.\d+)?$/.test(numeric);
    return { valid, score: valid ? 1 : 0.1 };
  }
  if (type === FIELD_TYPES.EMAIL) {
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    return { valid, score: valid ? 1 : 0.1 };
  }
  if (type === FIELD_TYPES.PHONE) {
    const digits = text.replace(/\D/g, "");
    const valid = digits.length >= 7 && digits.length <= 15;
    return { valid, score: valid ? 1 : 0.25 };
  }
  if (/\bgstin\b/.test(aliases)) {
    const compact = text.replace(/\s/g, "").toUpperCase();
    const valid = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(compact);
    return { valid, score: valid ? 1 : 0.15 };
  }
  if (/\bpan\b/.test(aliases)) {
    const valid = /^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(text.replace(/\s/g, ""));
    return { valid, score: valid ? 1 : 0.15 };
  }
  return { valid: true, score: 0.7 };
}

function findOcrConfidence(value, ocrData) {
  const target = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!target || !ocrData || !Array.isArray(ocrData.pages)) return null;
  for (const page of ocrData.pages) {
    const words = (page.words || []).filter((word) => word && word.text);
    for (let start = 0; start < words.length; start += 1) {
      let combined = "";
      const confidences = [];
      for (let end = start; end < Math.min(words.length, start + 8); end += 1) {
        combined += String(words[end].text).toLowerCase().replace(/[^a-z0-9]/g, "");
        if (Number.isFinite(words[end].confidence)) confidences.push(words[end].confidence);
        if (combined === target) {
          return confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length / 100 : null;
        }
        if (!target.startsWith(combined)) break;
      }
    }
  }
  return null;
}

function normalizeOcrToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Reconstruct visual text lines from Tesseract word boxes. This is a heuristic:
// it uses coordinates to find the value next to/below a label, then falls back
// to the existing plain-text matcher whenever geometry is missing or ambiguous.
function buildSpatialLines(ocrData) {
  const lines = [];
  for (const page of (ocrData && Array.isArray(ocrData.pages) ? ocrData.pages : [])) {
    const words = (page.words || []).filter((word) =>
      word && word.text && word.bbox &&
      Number.isFinite(word.bbox.x0) && Number.isFinite(word.bbox.x1) &&
      Number.isFinite(word.bbox.y0) && Number.isFinite(word.bbox.y1)
    ).map((word) => ({ ...word, pageNumber: page.pageNumber || 1,
      centerY: (word.bbox.y0 + word.bbox.y1) / 2,
      height: Math.max(1, word.bbox.y1 - word.bbox.y0),
    })).sort((a, b) => a.centerY - b.centerY || a.bbox.x0 - b.bbox.x0);

    const pageLines = [];
    for (const word of words) {
      let bestLine = null;
      let bestDistance = Infinity;
      for (const line of pageLines) {
        const lineCenter = line.words.reduce((sum, item) => sum + item.centerY, 0) / line.words.length;
        const lineHeight = line.words.reduce((sum, item) => sum + item.height, 0) / line.words.length;
        const distance = Math.abs(word.centerY - lineCenter);
        if (distance <= Math.max(6, Math.max(lineHeight, word.height) * 0.65) && distance < bestDistance) {
          bestLine = line;
          bestDistance = distance;
        }
      }
      if (!bestLine) {
        bestLine = { pageNumber: word.pageNumber, words: [] };
        pageLines.push(bestLine);
      }
      bestLine.words.push(word);
    }
    pageLines.forEach((line) => {
      line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      line.y0 = Math.min(...line.words.map((word) => word.bbox.y0));
      line.y1 = Math.max(...line.words.map((word) => word.bbox.y1));
      line.height = Math.max(1, line.y1 - line.y0);
      lines.push(line);
    });
  }
  return lines;
}

function findSpatialValueForAliases(ocrData, aliases, allAliases = []) {
  const lines = buildSpatialLines(ocrData);
  if (!lines.length || !Array.isArray(aliases) || !aliases.length) return null;
  const normalizedAliases = [...new Set([...aliases, ...allAliases]
    .map(normalizeOcrToken).filter((alias) => alias.length >= 2))];
  const targetAliases = [...new Set(aliases.map(normalizeOcrToken).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const candidates = [];

  const isAnotherLabelAt = (words, index, exceptAlias) => {
  let combined = "";
  for (let end = index; end < Math.min(words.length, index + 5); end += 1) {
    combined += normalizeOcrToken(words[end].text);
    if (!combined) continue;
    if (normalizedAliases.includes(combined) && combined !== exceptAlias) return true;
    if (!normalizedAliases.some((alias) => alias.startsWith(combined))) break;
  }
  return false;
};

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const words = line.words;
    for (let start = 0; start < words.length; start += 1) {
      for (const alias of targetAliases) {
        let combined = "";
        let aliasEnd = -1;
        for (let end = start; end < Math.min(words.length, start + 6); end += 1) {
          combined += normalizeOcrToken(words[end].text);
          if (!combined) continue;
          if (combined === alias) { aliasEnd = end; break; }
          if (!alias.startsWith(combined)) break;
        }
        if (aliasEnd < 0) continue;

        const collectValue = (valueWords, fromIndex, aliasText) => {
          const selected = [];
          for (let index = fromIndex; index < valueWords.length && selected.length < 10; index += 1) {
            const token = normalizeOcrToken(valueWords[index].text);
            if (!token || /^[|:;=#-]+$/.test(valueWords[index].text)) continue;
if (isAnotherLabelAt(valueWords, index, aliasText)) break;
            selected.push(valueWords[index]);
          }
          return selected;
        };

        let valueWords = collectValue(words, aliasEnd + 1, alias);
        let strategy = "spatial-same-line";
        if (!valueWords.length && lineIndex + 1 < lines.length) {
          const nextLine = lines[lineIndex + 1];
          if (nextLine.pageNumber === line.pageNumber && nextLine.y0 >= line.y0) {
           const labelX = words[start].bbox.x0;
let rightX = Infinity;
for (let k = aliasEnd + 1; k < words.length; k += 1) {
  if (isAnotherLabelAt(words, k, alias)) { rightX = words[k].bbox.x0; break; }
}
const tol = line.height * 0.75;
const column = nextLine.words.filter((word) => word.bbox.x0 >= labelX - tol && word.bbox.x0 < rightX - tol);
valueWords = collectValue(column, 0, alias);
strategy = "spatial-next-line";
          }
        }
        if (!valueWords.length) continue;
        const value = valueWords.map((word) => word.text).join(" ").replace(/^[|:;=#-]+\s*/, "").trim();
        if (!value) continue;
        // native PDF words ki confidence null hoti hai (OCR measure nahi hua): ise 0 mat ginna
        const confidences = valueWords.filter((word) => word.confidence !== null && word.confidence !== undefined)
          .map((word) => Number(word.confidence)).filter(Number.isFinite);        const ocrConfidence = confidences.length
          ? confidences.reduce((sum, score) => sum + score, 0) / confidences.length / 100
          : null;
        candidates.push({ value, matchedAlias: aliases.find((item) => normalizeOcrToken(item) === alias) || alias,
          strategy, score: strategy === "spatial-same-line" ? 0.96 : 0.84,
          lineIndex, ocrConfidence, pageNumber: line.pageNumber });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || (b.ocrConfidence ?? 0.7) - (a.ocrConfidence ?? 0.7));
  return candidates[0];
}

const crypto = require("crypto");
const { mapFields } = require("./ocr/fieldMapper");

async function loadVersionById(models, versionId) {
  const { MetadataTemplateVersion, MetadataField, OcrAlias } = models;
  return MetadataTemplateVersion.findOne({
    where: { id: versionId },
    include: [{ model: MetadataField, as: "fields", include: [{ model: OcrAlias, as: "ocrAliases" }], where: { status: "ACTIVE" }, required: false }],
    order: [[{ model: MetadataField, as: "fields" }, "displayOrder", "ASC"]],
  });
}

/**
 * Map OCR output into the document's template fields and persist it.
 *
 * Template binding: if the document already has a DocumentMetadata row, ITS
 * template version is used (never silently switched to a newer/other
 * template). Only first-time mapping resolves the active version for the
 * document type.
 *
 * Re-run safety (reprocess / retry):
 *  - CONFIRMED metadata is never changed; only the raw OCR snapshot is refreshed.
 *  - Fields the user corrected keep the user's value; other fields are re-mapped.
 *  - correctionHistory is preserved (previously it was reset to [] on every run).
 */
async function mapDocument({ documentId, tenantId, documentTypeId, extractedText, legacyFields, ocrData, ocrRun, models: injectedModels, dayFirst = true }) {
  const models = injectedModels || (await getTenantConnection(tenantId)).models;
  const { DocumentMetadata } = models;
  const existing = await DocumentMetadata.findOne({ where: { documentId } });

  let version = null;
  if (existing && existing.metadataTemplateVersionId) version = await loadVersionById(models, existing.metadataTemplateVersionId);
  if (!version) version = await metadataTemplateService.resolveActiveVersionForDocumentType(models, tenantId, documentTypeId);
  if (!version) return existing || null;

  const fields = (version.fields || []).slice().sort((a, b) => a.displayOrder - b.displayOrder);
  const { mapped, confidence } = mapFields({ fields, extractedText, ocrData, spatialFinder: findSpatialValueForAliases, dayFirst });
  const genericPairs = OcrService.extractGenericPairs(extractedText);

  // Formula fields are derived after OCR fields are populated.
  const computeFormulas = (values, conf) => {
    for (const field of fields) {
      if (field.fieldType !== FIELD_TYPES.FORMULA) continue;
      const formula = field.validation && field.validation.formula;
      if (!formula) continue;
      try { values[field.internalName] = evaluateFormula(formula, values); conf[field.internalName] = { confidence: CONFIDENCE_LEVELS.HIGH, score: 1, scoreType: "formula", source: "formula", validationPassed: true, status: "DERIVED" }; }
      catch (_) { conf[field.internalName] = { confidence: CONFIDENCE_LEVELS.LOW, score: 0, scoreType: "formula", source: "formula", validationPassed: false, status: "INVALID_FORMAT" }; }
    }
  };

  const textHash = crypto.createHash("sha256").update(String(extractedText || "")).digest("hex");
  const rawOcrJson = {
    extractedText, genericPairs, legacyFields: legacyFields || null,
    providerEntities: Array.isArray(ocrData && ocrData.providerEntities) ? ocrData.providerEntities.slice(0, 200) : undefined,
    ocrSummary: ocrData ? {
      provider: ocrData.provider, pageCount: ocrData.pageCount, averageConfidence: ocrData.averageConfidence,
      status: ocrData.status || null, pageSources: (ocrData.pages || []).map((p) => ({ page: p.pageNumber, source: p.source || null, error: p.error || null })),
      warnings: ocrData.warnings || [],
      engineRequested: ocrRun && ocrRun.engineRequested || null, engineUsed: (ocrRun && ocrRun.engineUsed) || ocrData.engine || ocrData.provider || null,
      fallbackUsed: !!(ocrRun && ocrRun.fallbackUsed), providerError: ocrRun && ocrRun.providerError ? { code: ocrRun.providerError.code, message: ocrRun.providerError.message } : null,
      templateVersionId: version.id, textHash, ocrAt: new Date().toISOString(),
    } : null,
  };

  // ── Re-run on existing record: protect user work ──────────────
  if (existing) {
    const history = Array.isArray(existing.correctionHistory) ? existing.correctionHistory : [];
    if (existing.status === "CONFIRMED") {
      await existing.update({ rawOcrJson: { ...rawOcrJson, ocrSummary: { ...rawOcrJson.ocrSummary, note: "OCR re-run; confirmed metadata left unchanged" } } });
      return existing;
    }
    const corrected = new Set(history.map((h) => h && h.internalName).filter(Boolean));
    const prevValues = existing.mappedMetadataJson || {}; const prevConf = existing.confidenceJson || {};
    for (const name of corrected) {
      if (Object.prototype.hasOwnProperty.call(prevValues, name)) {
        mapped[name] = prevValues[name];
        confidence[name] = { ...(prevConf[name] || {}), confidence: CONFIDENCE_LEVELS.HIGH, score: 1, scoreType: "manual", source: "manual-correction", status: "MANUALLY_EDITED", manuallyEdited: true };
      }
    }
  }
  computeFormulas(mapped, confidence);
  const { errors } = validateMetadata(fields, mapped);
  const payload = {
    documentId, metadataTemplateVersionId: version.id, rawOcrJson, mappedMetadataJson: mapped, confidenceJson: confidence, validationErrorsJson: errors,
    correctionHistory: existing && Array.isArray(existing.correctionHistory) ? existing.correctionHistory : [], status: "PENDING_REVIEW",
  };
  const [record] = await DocumentMetadata.upsert(payload, { returning: true });
  return record;
}

module.exports = { mapDocument, candidateAliasesForField, validateCandidate, findSpatialValueForAliases };
