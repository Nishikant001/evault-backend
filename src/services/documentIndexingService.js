// src/services/documentIndexingService.js
//
// Orchestrates the RAG indexing pipeline for one Document:
//   extracted text -> chunk -> embed -> store vectors -> Embedding status row
//
// Called two ways:
//   1. Best-effort, fire-and-forget from workers/ocrWorker.js right after
//      OCR completes (see that file for the additive hook).
//   2. Explicitly via POST /api/ai/documents/:id/reindex (documentAIController),
//      which always re-chunks/re-embeds from the current extracted text.
//
// Never throws to a caller that can't handle it silently — the OCR worker
// hook wraps this in its own try/catch, and the reindex controller surfaces
// errors as a normal HTTP error response.

// PHASE G — all models here are tenant-side. indexDocument now takes
// `tenantId` explicitly (both call sites already have it in scope —
// see documentAIController.js and workers/ocrWorker.js) and resolves
// its own tenant connection via the same cache every HTTP request uses.
const { getTenantConnection } = require("./tenantConnectionManager");
const { chunkText } = require("./chunkingService");
const aiProviderService = require("./aiProviderService");
const VectorStoreFactory = require("./vectorStore/vectorStoreFactory");

const EMBED_BATCH_SIZE = 32;

function extractDocumentText(document, dynamicMetadata) {
  // Prefer the raw OCR text captured on the document itself (always present
  // once OCR_COMPLETED); dynamicMetadata.rawOcrJson is a secondary source
  // for documents that only have the newer per-document metadata row.
  const fromDocument = document.ocrMetadata && document.ocrMetadata.extractedText;
  if (fromDocument) return fromDocument;

  const fromDynamic = dynamicMetadata && dynamicMetadata.rawOcrJson && dynamicMetadata.rawOcrJson.extractedText;
  return fromDynamic || "";
}

async function indexDocument(tenantId, documentId, { force = false } = {}) {
  const { Document, DocumentMetadata, DocumentChunk, Embedding } = (await getTenantConnection(tenantId)).models;
  const document = await Document.findByPk(documentId, {
    include: [{ model: DocumentMetadata, as: "dynamicMetadata" }],
  });
  if (!document) throw new Error(`Document ${documentId} not found`);

  const [embeddingRow] = await Embedding.findOrCreate({
    where: { documentId },
    defaults: { tenantId: document.tenantId, status: "PENDING" },
  });

  if (embeddingRow.status === "PROCESSING" && !force) {
    return embeddingRow; // avoid double-indexing an in-flight document
  }

  await embeddingRow.update({ status: "PROCESSING", errorMessage: null });

  try {
    const settings = await aiProviderService.getOrCreateSettings(document.tenantId);
    const rawText = extractDocumentText(document, document.dynamicMetadata);

    if (!rawText || !rawText.trim()) {
      await embeddingRow.update({ status: "SKIPPED_NO_TEXT", chunkCount: 0, lastIndexedAt: new Date() });
      return embeddingRow;
    }

    const store = VectorStoreFactory.getStore(settings.vectorStoreProvider);

    // Wipe any previous chunks for this document (reindex is idempotent).
    await store
      .deleteByDocument({ tenantId: document.tenantId, documentId, vectorStoreConfig: settings.vectorStoreConfigJson || {} })
      .catch(() => {});
    await DocumentChunk.destroy({ where: { documentId } });

    const pieces = chunkText(rawText, {
      chunkSize: settings.chunkSize,
      overlap: settings.chunkOverlap,
      pageNumber: 1, // OcrService currently OCRs only page 1 of a PDF — see ocrService.js
    });

    if (!pieces.length) {
      await embeddingRow.update({ status: "SKIPPED_NO_TEXT", chunkCount: 0, lastIndexedAt: new Date() });
      return embeddingRow;
    }

    const metadataJson = {
      documentName: document.originalFileName,
      departmentId: document.departmentId,
      categoryId: document.categoryId,
      documentTypeId: document.documentTypeId,
      sapDocumentId: document.sapDocumentId,
    };

    const chunkRows = await DocumentChunk.bulkCreate(
      pieces.map((p, idx) => ({
        tenantId: document.tenantId,
        documentId: document.id,
        chunkIndex: idx,
        pageNumber: p.pageNumber,
        content: p.content,
        tokenCount: Math.ceil(p.content.length / 4), // rough heuristic, no tokenizer dependency
        metadataJson,
      }))
    );

    let embeddingProvider = null;
    let embeddingModel = null;

    for (let i = 0; i < chunkRows.length; i += EMBED_BATCH_SIZE) {
      const batch = chunkRows.slice(i, i + EMBED_BATCH_SIZE);
      const { embeddings, provider, model } = await aiProviderService.callEmbeddings(
        document.tenantId,
        batch.map((c) => c.content)
      );
      embeddingProvider = provider;
      embeddingModel = model;

      const upsertPayload = batch.map((chunk, idx) => ({
        chunkId: chunk.id,
        tenantId: document.tenantId,
        documentId: document.id,
        embedding: embeddings[idx],
        provider,
        model,
      }));

      const upserted = await store.upsert({
        chunks: upsertPayload,
        vectorStoreConfig: settings.vectorStoreConfigJson || {},
      });

      // For external stores, persist the pointer + embedding metadata back
      // onto the chunk row (embeddingJson stays null — the vector lives externally).
      for (const result of upserted) {
        if (result.externalVectorId) {
          await DocumentChunk.update(
            {
              externalVectorId: result.externalVectorId,
              embeddingProvider: provider,
              embeddingModel: model,
              embeddingDim: embeddings[0]?.length || null,
            },
            { where: { id: result.chunkId } }
          );
        }
      }
    }

    await embeddingRow.update({
      status: "INDEXED",
      vectorStoreProvider: settings.vectorStoreProvider,
      embeddingProvider,
      embeddingModel,
      chunkCount: chunkRows.length,
      lastIndexedAt: new Date(),
      errorMessage: null,
    });

    return embeddingRow;
  } catch (error) {
    await embeddingRow.update({ status: "FAILED", errorMessage: error.message });
    throw error;
  }
}

module.exports = { indexDocument, extractDocumentText };
