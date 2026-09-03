// src/controllers/documentAIController.js
const summaryService = require("../services/summaryService");
const classificationService = require("../services/classificationService");
const documentIndexingService = require("../services/documentIndexingService");
const vectorSearchService = require("../services/vectorSearchService");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

const wrap = (fn) => async (req, res) => {
  try {
    const data = await fn(req);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const summarize = wrap(async (req) => {
  const result = await summaryService.summarizeDocument({
    documentId: req.params.id,
    tenantId: req.user.tenantId,
    userId: req.user.id,
  });
  await AuditService.log({
    req,
    module: AUDIT_MODULES.AI_ASSISTANT,
    action: AUDIT_ACTIONS.DOCUMENT_SUMMARIZED,
    newValue: { documentId: req.params.id },
    remarks: "Generated an AI summary for a document",
    status: AUDIT_STATUS.SUCCESS,
  });
  return result;
});

const explain = wrap(async (req) => {
  const result = await summaryService.explainDocument({
    documentId: req.params.id,
    tenantId: req.user.tenantId,
    userId: req.user.id,
  });
  await AuditService.log({
    req,
    module: AUDIT_MODULES.AI_ASSISTANT,
    action: AUDIT_ACTIONS.DOCUMENT_EXPLAINED,
    newValue: { documentId: req.params.id },
    remarks: "Generated an AI explanation for a document",
    status: AUDIT_STATUS.SUCCESS,
  });
  return result;
});

const compare = wrap(async (req) => {
  const { documentIdA, documentIdB } = req.body;
  if (!documentIdA || !documentIdB) {
    const err = new Error("documentIdA and documentIdB are required");
    err.statusCode = 400;
    throw err;
  }
  const result = await summaryService.compareDocuments({
    documentIdA,
    documentIdB,
    tenantId: req.user.tenantId,
    userId: req.user.id,
  });
  await AuditService.log({
    req,
    module: AUDIT_MODULES.AI_ASSISTANT,
    action: AUDIT_ACTIONS.DOCUMENT_COMPARED,
    newValue: { documentIdA, documentIdB },
    remarks: "Compared two documents with AI",
    status: AUDIT_STATUS.SUCCESS,
  });
  return result;
});

const findDuplicates = wrap(async (req) => {
  const result = await classificationService.findDuplicates({ documentId: req.params.id, tenantId: req.user.tenantId });
  await AuditService.log({
    req,
    module: AUDIT_MODULES.AI_ASSISTANT,
    action: AUDIT_ACTIONS.DOCUMENT_DUPLICATES_SCANNED,
    newValue: { documentId: req.params.id, found: result.duplicates.length },
    remarks: "Scanned for duplicate documents",
    status: AUDIT_STATUS.SUCCESS,
  });
  return result;
});

const missingMetadata = wrap((req) =>
  classificationService.detectMissingMetadata({ documentId: req.params.id, tenantId: req.user.tenantId })
);

const ocrInconsistencies = wrap((req) =>
  classificationService.detectOcrInconsistencies({ documentId: req.params.id, tenantId: req.user.tenantId })
);

const validateTotals = wrap((req) =>
  classificationService.validateTotals({ documentId: req.params.id, tenantId: req.user.tenantId })
);

const autoClassify = wrap(async (req) => {
  const result = await classificationService.autoClassify({
    documentId: req.params.id,
    tenantId: req.user.tenantId,
    userId: req.user.id,
  });
  await AuditService.log({
    req,
    module: AUDIT_MODULES.AI_ASSISTANT,
    action: AUDIT_ACTIONS.DOCUMENT_AUTO_CLASSIFIED,
    newValue: { documentId: req.params.id, ...result },
    remarks: "Auto-classified a document with AI",
    status: AUDIT_STATUS.SUCCESS,
  });
  return result;
});

const autoTag = wrap(async (req) => {
  const result = await classificationService.autoTag({
    documentId: req.params.id,
    tenantId: req.user.tenantId,
    userId: req.user.id,
  });
  await AuditService.log({
    req,
    module: AUDIT_MODULES.AI_ASSISTANT,
    action: AUDIT_ACTIONS.DOCUMENT_AUTO_TAGGED,
    newValue: { documentId: req.params.id, tags: result.tags },
    remarks: "Auto-tagged a document with AI",
    status: AUDIT_STATUS.SUCCESS,
  });
  return result;
});

const suggestFolder = wrap((req) =>
  classificationService.suggestFolder({ documentId: req.params.id, tenantId: req.user.tenantId, userId: req.user.id })
);

const reindex = wrap(async (req) => {
  const result = await documentIndexingService.indexDocument(req.user.tenantId, req.params.id, { force: true });
  await AuditService.log({
    req,
    module: AUDIT_MODULES.AI_ASSISTANT,
    action: AUDIT_ACTIONS.DOCUMENT_REINDEXED,
    newValue: { documentId: req.params.id, status: result.status, chunkCount: result.chunkCount },
    remarks: "Re-indexed a document for the AI assistant",
    status: AUDIT_STATUS.SUCCESS,
  });
  return result;
});

// ── Search endpoints ─────────────────────────────────────────────
const semanticSearch = wrap(async (req) => {
  const { query, documentIds, topK } = req.query.query ? req.query : req.body;
  if (!query) {
    const err = new Error("query is required");
    err.statusCode = 400;
    throw err;
  }
  const parsedDocIds = documentIds
    ? (Array.isArray(documentIds) ? documentIds : String(documentIds).split(",")).map(Number)
    : undefined;
  return vectorSearchService.search({ tenantId: req.user.tenantId, query, documentIds: parsedDocIds, topK: topK ? Number(topK) : undefined });
});

const metadataSearch = wrap((req) => {
  const keyword = req.query.keyword || req.body.keyword;
  if (!keyword) {
    const err = new Error("keyword is required");
    err.statusCode = 400;
    throw err;
  }
  return vectorSearchService.metadataSearch({ tenantId: req.user.tenantId, keyword });
});

const ocrSearch = wrap((req) => {
  const keyword = req.query.keyword || req.body.keyword;
  if (!keyword) {
    const err = new Error("keyword is required");
    err.statusCode = 400;
    throw err;
  }
  return vectorSearchService.ocrKeywordSearch({ tenantId: req.user.tenantId, keyword });
});

module.exports = {
  summarize,
  explain,
  compare,
  findDuplicates,
  missingMetadata,
  ocrInconsistencies,
  validateTotals,
  autoClassify,
  autoTag,
  suggestFolder,
  reindex,
  semanticSearch,
  metadataSearch,
  ocrSearch,
};
