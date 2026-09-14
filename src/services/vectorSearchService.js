// src/services/vectorSearchService.js
//
// Embeds a query string and retrieves the most relevant DocumentChunk rows
// for a tenant, honoring an optional document/folder scope. This is the
// single retrieval entry point used by chatService (RAG) and the
// metadata/OCR/semantic search endpoints.

const { DocumentChunk, Document } = require("../models");
const aiProviderService = require("./aiProviderService");
const VectorStoreFactory = require("./vectorStore/vectorStoreFactory");
const { DEFAULT_TOP_K } = require("../constants/aiConstants");

/**
 * @param {object} params
 * @param {number} params.tenantId
 * @param {string} params.query
 * @param {number[]} [params.documentIds] - restrict search to these documents (chat scope)
 * @param {number} [params.topK]
 */
async function search({ tenantId, query, documentIds, topK }) {
  const settings = await aiProviderService.getOrCreateSettings(tenantId);
  const k = topK || settings.topK || DEFAULT_TOP_K;

  const { embeddings } = await aiProviderService.callEmbeddings(tenantId, [query]);
  const queryEmbedding = embeddings[0];
  if (!queryEmbedding || !queryEmbedding.length) {
    throw new Error("Failed to generate an embedding for the query");
  }

  const store = VectorStoreFactory.getStore(settings.vectorStoreProvider);
  const results = await store.search({
    tenantId,
    documentIds,
    queryEmbedding,
    topK: k,
    vectorStoreConfig: settings.vectorStoreConfigJson || {},
  });

  if (!results.length) return [];

  const chunkIds = results.map((r) => r.chunkId);
  const chunks = await DocumentChunk.findAll({
    where: { id: chunkIds },
    include: [{ model: Document, attributes: ["id", "originalFileName", "uploadStatus", "documentTypeId", "categoryId", "departmentId"] }],
  });

  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const EXCLUDED_STATUSES = new Set(["FAILED", "REJECTED"]);

  return results
    .map((r) => {
      const chunk = chunkById.get(r.chunkId);
      if (!chunk || !chunk.Document || EXCLUDED_STATUSES.has(chunk.Document.uploadStatus)) return null;
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        documentName: chunk.Document.originalFileName,
        pageNumber: chunk.pageNumber,
        content: chunk.content,
        score: r.score,
      };
    })
    .filter(Boolean);
}

module.exports = { search, metadataSearch, ocrKeywordSearch };

// ── Metadata search ──────────────────────────────────────────────
// Keyword match over DocumentMetadata.mappedMetadataJson values (not
// semantic — a plain substring match across every mapped field).
async function metadataSearch({ tenantId, keyword, limit = 20 }) {
  const { DocumentMetadata } = require("../models");
  const rows = await DocumentMetadata.findAll({
    include: [{ model: Document, where: { tenantId }, attributes: ["id", "originalFileName", "uploadStatus"] }],
  });

  const needle = keyword.toLowerCase();
  const matches = [];
  for (const row of rows) {
    const mapped = row.mappedMetadataJson || {};
    const hitFields = Object.entries(mapped).filter(
      ([, value]) => value !== null && value !== undefined && String(value).toLowerCase().includes(needle)
    );
    if (hitFields.length) {
      matches.push({
        documentId: row.documentId,
        documentName: row.Document?.originalFileName,
        matchedFields: hitFields.map(([field, value]) => ({ field, value })),
      });
    }
    if (matches.length >= limit) break;
  }
  return matches;
}

// ── OCR text search ──────────────────────────────────────────────
// Keyword match over the raw OCR text captured on each Document — useful
// when a term doesn't live in a mapped metadata field at all.
async function ocrKeywordSearch({ tenantId, keyword, limit = 20 }) {
  const documents = await Document.findAll({
    where: { tenantId },
    attributes: ["id", "originalFileName", "ocrMetadata", "uploadStatus"],
  });

  const needle = keyword.toLowerCase();
  const matches = [];
  for (const doc of documents) {
    const text = doc.ocrMetadata && doc.ocrMetadata.extractedText;
    if (text && text.toLowerCase().includes(needle)) {
      const idx = text.toLowerCase().indexOf(needle);
      matches.push({
        documentId: doc.id,
        documentName: doc.originalFileName,
        snippet: text.slice(Math.max(0, idx - 80), idx + 160),
      });
    }
    if (matches.length >= limit) break;
  }
  return matches;
}
