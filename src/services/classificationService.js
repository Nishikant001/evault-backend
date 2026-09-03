// src/services/classificationService.js
//
// Document AI features that reason about metadata/structure rather than
// free-text Q&A: duplicate detection, missing-metadata detection, OCR
// inconsistency detection, total validation, auto-classification, auto
// tagging, and folder suggestions.

const {
  Document,
  DocumentMetadata,
  Department,
  Category,
  DocumentType,
  MetadataField,
  MetadataTemplateVersion,
  TemplateAssignment,
} = require("../models");
const vectorSearchService = require("./vectorSearchService");
const aiProviderService = require("./aiProviderService");
const { extractDocumentText } = require("./documentIndexingService");
const PromptHistory = require("../models/PromptHistory");

const DUPLICATE_SCORE_THRESHOLD = 0.9;

// ── Duplicate detection ─────────────────────────────────────────
// Uses the document's own (already-indexed) text as a semantic search
// query against the rest of the tenant's library — documents whose chunks
// come back with very high similarity are flagged as likely duplicates.
async function findDuplicates({ documentId, tenantId }) {
  const document = await Document.findOne({
    where: { id: documentId, tenantId },
    include: [{ model: DocumentMetadata, as: "dynamicMetadata" }],
  });
  if (!document) {
    const err = new Error("Document not found");
    err.statusCode = 404;
    throw err;
  }

  const text = extractDocumentText(document, document.dynamicMetadata);
  if (!text || !text.trim()) {
    return { documentId, duplicates: [], note: "Document has no extracted text to compare yet." };
  }

  const results = await vectorSearchService.search({
    tenantId,
    query: text.slice(0, 4000),
    topK: 15,
  });

  const byDocument = new Map();
  for (const r of results) {
    if (r.documentId === Number(documentId)) continue;
    if (!byDocument.has(r.documentId) || byDocument.get(r.documentId).score < r.score) {
      byDocument.set(r.documentId, r);
    }
  }

  const duplicates = [...byDocument.values()]
    .filter((r) => r.score >= DUPLICATE_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .map((r) => ({ documentId: r.documentId, documentName: r.documentName, similarity: r.score }));

  return { documentId: Number(documentId), duplicates };
}

// ── Missing metadata detection ──────────────────────────────────
// Compares DocumentMetadata.mappedMetadataJson against the required fields
// on the DocumentType's currently-assigned MetadataTemplateVersion.
async function detectMissingMetadata({ documentId, tenantId }) {
  const document = await Document.findOne({ where: { id: documentId, tenantId } });
  if (!document) {
    const err = new Error("Document not found");
    err.statusCode = 404;
    throw err;
  }

  const dynamicMetadata = await DocumentMetadata.findOne({ where: { documentId } });
  const mapped = (dynamicMetadata && dynamicMetadata.mappedMetadataJson) || {};

  const assignment = document.documentTypeId
    ? await TemplateAssignment.findOne({ where: { tenantId, documentTypeId: document.documentTypeId } })
    : null;

  if (!assignment || !assignment.metadataTemplateVersionId) {
    return { documentId: Number(documentId), missingFields: [], note: "No metadata template is assigned to this document's type." };
  }

  const requiredFields = await MetadataField.findAll({
    where: { metadataTemplateVersionId: assignment.metadataTemplateVersionId, required: true },
  });

  const missingFields = requiredFields
    .filter((f) => {
      const value = mapped[f.internalName];
      return value === undefined || value === null || String(value).trim() === "";
    })
    .map((f) => ({ internalName: f.internalName, label: f.label || f.internalName }));

  return { documentId: Number(documentId), missingFields };
}

// ── OCR inconsistency detection ──────────────────────────────────
// Surfaces fields the dynamic mapping engine already flagged as low
// confidence or failing validation — no extra LLM call needed since
// dynamicOcrMappingService / metadataValidationService already computed this.
async function detectOcrInconsistencies({ documentId, tenantId }) {
  const document = await Document.findOne({ where: { id: documentId, tenantId } });
  if (!document) {
    const err = new Error("Document not found");
    err.statusCode = 404;
    throw err;
  }

  const dynamicMetadata = await DocumentMetadata.findOne({ where: { documentId } });
  if (!dynamicMetadata) {
    return { documentId: Number(documentId), inconsistencies: [], note: "No dynamic OCR mapping available for this document." };
  }

  const confidence = dynamicMetadata.confidenceJson || {};
  const validationErrors = dynamicMetadata.validationErrorsJson || {};

  const inconsistencies = [];
  for (const [field, info] of Object.entries(confidence)) {
    if (info && (info.confidence === "Low" || info.confidence === "Mid")) {
      inconsistencies.push({ field, issue: `OCR confidence is ${info.confidence}`, score: info.score });
    }
  }
  for (const [field, errors] of Object.entries(validationErrors)) {
    if (Array.isArray(errors) && errors.length) {
      inconsistencies.push({ field, issue: errors.join("; ") });
    }
  }

  return { documentId: Number(documentId), inconsistencies };
}

// ── Validate totals (Subtotal + GST = Total) ──────────────────────
function toNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function findField(mapped, patterns) {
  const entry = Object.entries(mapped).find(([key]) => patterns.some((p) => p.test(key)));
  return entry ? toNumber(entry[1]) : null;
}

async function validateTotals({ documentId, tenantId }) {
  const dynamicMetadata = await DocumentMetadata.findOne({ where: { documentId } });
  const mapped = (dynamicMetadata && dynamicMetadata.mappedMetadataJson) || {};

  const subtotal = findField(mapped, [/subtotal/i, /sub_total/i, /sub-total/i]);
  const tax = findField(mapped, [/gst/i, /tax/i, /vat/i]);
  const total = findField(mapped, [/^total$/i, /grand_?total/i, /amount_?due/i, /invoice_?total/i]);

  if (subtotal === null || tax === null || total === null) {
    return {
      documentId: Number(documentId),
      valid: null,
      note: "Could not locate Subtotal, GST/Tax, and Total fields in this document's mapped metadata.",
      found: { subtotal, tax, total },
    };
  }

  const expected = Number((subtotal + tax).toFixed(2));
  const actual = Number(total.toFixed(2));
  const diff = Number((expected - actual).toFixed(2));
  const valid = Math.abs(diff) <= 0.01;

  return { documentId: Number(documentId), valid, subtotal, tax, total, expected, difference: diff };
}

// ── Auto-classify + folder suggestions ────────────────────────────
async function autoClassify({ documentId, tenantId, userId }) {
  const document = await Document.findOne({
    where: { id: documentId, tenantId },
    include: [{ model: DocumentMetadata, as: "dynamicMetadata" }],
  });
  if (!document) {
    const err = new Error("Document not found");
    err.statusCode = 404;
    throw err;
  }

  const text = extractDocumentText(document, document.dynamicMetadata);
  if (!text || !text.trim()) {
    const err = new Error("This document has no extracted text yet (OCR may still be processing).");
    err.statusCode = 422;
    throw err;
  }

  const [departments, categories, documentTypes] = await Promise.all([
    Department.findAll({
      include: [{ association: "tenants", where: { id: tenantId }, attributes: [] }],
    }).catch(() => []),
    Category.findAll({ where: { tenantId } }),
    DocumentType.findAll({ where: { tenantId } }),
  ]);

  const taxonomy = {
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
    categories: categories.map((c) => ({ id: c.id, name: c.name, departmentId: c.departmentId })),
    documentTypes: documentTypes.map((t) => ({ id: t.id, name: t.name, categoryId: t.categoryId })),
  };

  const instruction = [
    "Given this document's text and the tenant's existing taxonomy (departments, categories, document types),",
    "suggest the single best-matching Department, Category, and DocumentType, plus 5-8 short descriptive tags.",
    "Respond with STRICT JSON only in this exact shape:",
    '{"departmentId": <id or null>, "categoryId": <id or null>, "documentTypeId": <id or null>, "confidence": <0-1 number>, "tags": ["tag1", "tag2"], "reasoning": "<one sentence>"}',
    "If nothing matches well, use null for that id.",
  ].join("\n");

  const messages = [
    { role: "system", content: "You are an enterprise document classification assistant." },
    {
      role: "user",
      content: `${instruction}\n\nTAXONOMY:\n${JSON.stringify(taxonomy)}\n\nDOCUMENT TEXT:\n${text.slice(0, 6000)}`,
    },
  ];

  const completion = await aiProviderService.callChat(tenantId, messages, { temperature: 0.1 });

  let parsed;
  try {
    parsed = JSON.parse(completion.text.trim().replace(/^```json/i, "").replace(/```$/, "").trim());
  } catch {
    parsed = { departmentId: null, categoryId: null, documentTypeId: null, confidence: 0, tags: [], reasoning: completion.text };
  }

  await PromptHistory.create({
    tenantId,
    userId,
    feature: "CLASSIFY",
    provider: completion.provider,
    model: completion.model,
    prompt: instruction,
    response: completion.text,
    promptTokens: completion.promptTokens,
    completionTokens: completion.completionTokens,
    status: "SUCCESS",
  });

  return { documentId: Number(documentId), ...parsed };
}

async function autoTag({ documentId, tenantId, userId }) {
  const classification = await autoClassify({ documentId, tenantId, userId });
  return { documentId: Number(documentId), tags: classification.tags || [] };
}

async function suggestFolder({ documentId, tenantId, userId }) {
  const classification = await autoClassify({ documentId, tenantId, userId });
  return {
    documentId: Number(documentId),
    suggestedPath: {
      departmentId: classification.departmentId,
      categoryId: classification.categoryId,
      documentTypeId: classification.documentTypeId,
    },
    confidence: classification.confidence,
    reasoning: classification.reasoning,
  };
}

module.exports = {
  findDuplicates,
  detectMissingMetadata,
  detectOcrInconsistencies,
  validateTotals,
  autoClassify,
  autoTag,
  suggestFolder,
};
