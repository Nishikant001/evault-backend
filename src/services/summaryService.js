// src/services/summaryService.js
//
// Document AI features that operate on ONE or TWO documents' full text
// rather than a retrieval query: Summarize, Explain, Compare.

const { Document, DocumentMetadata, DocumentChunk } = require("../models");
const aiProviderService = require("./aiProviderService");
const { extractDocumentText } = require("./documentIndexingService");
const PromptHistory = require("../models/PromptHistory");

const MAX_CHARS = 14000; // keep prompts within a safe context budget across providers

async function loadDocumentText(documentId, tenantId) {
  const document = await Document.findOne({
    where: { id: documentId, tenantId },
    include: [{ model: DocumentMetadata, as: "dynamicMetadata" }],
  });
  if (!document) {
    const err = new Error("Document not found");
    err.statusCode = 404;
    throw err;
  }

  let text = extractDocumentText(document, document.dynamicMetadata);

  // Fall back to stitching indexed chunks together if raw OCR text is
  // unavailable but the document was indexed some other way.
  if (!text) {
    const chunks = await DocumentChunk.findAll({
      where: { documentId },
      order: [["chunkIndex", "ASC"]],
    });
    text = chunks.map((c) => c.content).join("\n\n");
  }

  return { document, text: text.slice(0, MAX_CHARS) };
}

async function runSingleDocumentPrompt({ documentId, tenantId, userId, feature, instruction }) {
  const { document, text } = await loadDocumentText(documentId, tenantId);

  if (!text.trim()) {
    const err = new Error("This document has no extracted text yet (OCR may still be processing).");
    err.statusCode = 422;
    throw err;
  }

  const messages = [
    {
      role: "system",
      content: "You are an enterprise document assistant. Be accurate, concise, and business-appropriate. Only use the document text provided.",
    },
    { role: "user", content: `${instruction}\n\nDOCUMENT: "${document.originalFileName}"\n\n${text}` },
  ];

  const completion = await aiProviderService.callChat(tenantId, messages, { temperature: 0.2 });

  await PromptHistory.create({
    tenantId,
    userId,
    feature,
    provider: completion.provider,
    model: completion.model,
    prompt: instruction,
    response: completion.text,
    promptTokens: completion.promptTokens,
    completionTokens: completion.completionTokens,
    totalTokens: (completion.promptTokens || 0) + (completion.completionTokens || 0),
    latencyMs: completion.latencyMs,
    status: "SUCCESS",
  });

  return { documentId, documentName: document.originalFileName, result: completion.text, provider: completion.provider, model: completion.model };
}

async function summarizeDocument({ documentId, tenantId, userId }) {
  return runSingleDocumentPrompt({
    documentId,
    tenantId,
    userId,
    feature: "SUMMARIZE",
    instruction: "Summarize this document in 4-6 concise bullet points, covering its purpose, key parties/entities, key figures/dates, and any action items.",
  });
}

async function explainDocument({ documentId, tenantId, userId }) {
  return runSingleDocumentPrompt({
    documentId,
    tenantId,
    userId,
    feature: "EXPLAIN",
    instruction: "Explain this document in plain language for someone unfamiliar with it: what it is, why it exists, and what each major section/field means.",
  });
}

async function compareDocuments({ documentIdA, documentIdB, tenantId, userId }) {
  const [a, b] = await Promise.all([
    loadDocumentText(documentIdA, tenantId),
    loadDocumentText(documentIdB, tenantId),
  ]);

  const instruction = [
    "Compare the two documents below. Return:",
    "1. Key similarities",
    "2. Key differences (be specific about values/dates/parties that differ)",
    "3. Anything present in one document but missing from the other",
    "4. A one-line verdict on whether these appear to be the same document, versions of each other, or unrelated.",
  ].join("\n");

  const messages = [
    { role: "system", content: "You are an enterprise document assistant performing a careful side-by-side document comparison." },
    {
      role: "user",
      content: `${instruction}\n\nDOCUMENT A: "${a.document.originalFileName}"\n${a.text}\n\n---\n\nDOCUMENT B: "${b.document.originalFileName}"\n${b.text}`,
    },
  ];

  const completion = await aiProviderService.callChat(tenantId, messages, { temperature: 0.1 });

  await PromptHistory.create({
    tenantId,
    userId,
    feature: "COMPARE",
    provider: completion.provider,
    model: completion.model,
    prompt: instruction,
    response: completion.text,
    promptTokens: completion.promptTokens,
    completionTokens: completion.completionTokens,
    totalTokens: (completion.promptTokens || 0) + (completion.completionTokens || 0),
    latencyMs: completion.latencyMs,
    status: "SUCCESS",
  });

  return {
    documentA: { id: a.document.id, name: a.document.originalFileName },
    documentB: { id: b.document.id, name: b.document.originalFileName },
    result: completion.text,
  };
}

module.exports = { summarizeDocument, explainDocument, compareDocuments, loadDocumentText };
