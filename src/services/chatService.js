// src/services/chatService.js
//
// Orchestrates one turn of the RAG chatbot:
//   resolve session scope -> vector search -> build grounded prompt
//   -> call configured LLM -> parse answer + follow-ups -> persist
//   ChatMessage (both turns) + PromptHistory -> return to controller.

const { ChatSession, ChatMessage, Document } = require("../models");
const vectorSearchService = require("./vectorSearchService");
const aiProviderService = require("./aiProviderService");
const PromptHistory = require("../models/PromptHistory");

const HISTORY_TURNS = 6; // last N messages included as conversational context

async function createSession({ tenantId, userId, title, scopeType, scopeDocumentIds, scopeFolderJson }) {
  return ChatSession.create({
    tenantId,
    userId,
    title: title || null,
    scopeType: scopeType || "ALL",
    scopeDocumentIds: scopeDocumentIds || null,
    scopeFolderJson: scopeFolderJson || null,
  });
}

async function listSessions({ tenantId, userId }) {
  return ChatSession.findAll({
    where: { tenantId, userId, isArchived: false },
    order: [["lastMessageAt", "DESC"], ["createdAt", "DESC"]],
  });
}

async function getSession(sessionId, tenantId) {
  const session = await ChatSession.findOne({ where: { id: sessionId, tenantId } });
  if (!session) {
    const err = new Error("Chat session not found");
    err.statusCode = 404;
    throw err;
  }
  return session;
}

async function getMessages(sessionId, tenantId) {
  await getSession(sessionId, tenantId);
  return ChatMessage.findAll({ where: { sessionId, tenantId }, order: [["createdAt", "ASC"]] });
}

async function deleteSession(sessionId, tenantId) {
  const session = await getSession(sessionId, tenantId);
  await session.destroy();
  return { id: sessionId };
}

// Resolves a session's scope into a concrete list of document IDs, or
// `null` meaning "no restriction — search the whole tenant library".
async function resolveScopeDocumentIds(session) {
  if (session.scopeType === "DOCUMENT" || session.scopeType === "DOCUMENT_SET") {
    const ids = session.scopeDocumentIds;
    return Array.isArray(ids) ? ids : ids ? [ids] : null;
  }

  if (session.scopeType === "FOLDER" && session.scopeFolderJson) {
    const { departmentId, categoryId, documentTypeId } = session.scopeFolderJson;
    const where = { tenantId: session.tenantId, uploadStatus: { [require("sequelize").Op.notIn]: ["FAILED", "REJECTED"] } };
    if (departmentId) where.departmentId = departmentId;
    if (categoryId) where.categoryId = categoryId;
    if (documentTypeId) where.documentTypeId = documentTypeId;
    const docs = await Document.findAll({ where, attributes: ["id"] });
    return docs.map((d) => d.id);
  }

  return null; // ALL
}

function buildSystemPrompt() {
  return [
    "You are an enterprise document assistant embedded in a Document Management System.",
    "Answer the user's question using ONLY the CONTEXT sections provided below, which are excerpts",
    "retrieved from the tenant's own documents (OCR text, and where available SAP-linked metadata).",
    "Every context excerpt is labeled [n] with its source document and page number.",
    "Rules:",
    "1. Ground every factual claim in the provided context. If the context does not contain the answer, say so plainly — do not guess.",
    "2. When you use a piece of context, reference it inline using its [n] label.",
    "3. Be concise and business-appropriate.",
    "Respond with STRICT JSON only, no markdown fences, in this exact shape:",
    '{"answer": "<your answer text, with [n] citation markers inline>", "followUpQuestions": ["<question 1>", "<question 2>"]}',
  ].join("\n");
}

function buildContextBlock(chunks) {
  return chunks
    .map((c, idx) => `[${idx + 1}] (Document: "${c.documentName}", Page ${c.pageNumber || 1})\n${c.content}`)
    .join("\n\n---\n\n");
}

function parseModelJson(text) {
  const cleaned = (text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      answer: parsed.answer || text,
      followUpQuestions: Array.isArray(parsed.followUpQuestions) ? parsed.followUpQuestions.slice(0, 4) : [],
    };
  } catch {
    return { answer: text, followUpQuestions: [] };
  }
}

function computeConfidence(chunks) {
  if (!chunks.length) return 0.15; // no grounding context found at all
  const avg = chunks.reduce((sum, c) => sum + (c.score || 0), 0) / chunks.length;
  return Math.max(0, Math.min(1, Number(avg.toFixed(3))));
}

async function sendMessage({ sessionId, tenantId, userId, message, topK }) {
  const session = await getSession(sessionId, tenantId);
  const documentIds = await resolveScopeDocumentIds(session);

  await ChatMessage.create({ sessionId, tenantId, userId, role: "USER", content: message });

  const priorMessages = await ChatMessage.findAll({
    where: { sessionId, tenantId },
    order: [["createdAt", "DESC"]],
    limit: HISTORY_TURNS,
  });

  let retrievedChunks = [];
  const start = Date.now();

  try {
    retrievedChunks = await vectorSearchService.search({ tenantId, query: message, documentIds, topK });

    const messages = [
      { role: "system", content: buildSystemPrompt() },
      ...priorMessages
        .reverse()
        .slice(0, -1) // drop the USER message we just added — it goes in as the final turn below
        .map((m) => ({ role: m.role === "ASSISTANT" ? "assistant" : "user", content: m.content })),
      {
        role: "user",
        content: `CONTEXT:\n${buildContextBlock(retrievedChunks) || "(no relevant context found in the document library)"}\n\nQUESTION: ${message}`,
      },
    ];

    const settings = await aiProviderService.getOrCreateSettings(tenantId);
    const completion = await aiProviderService.callChat(tenantId, messages, { temperature: settings.temperature });
    const { answer, followUpQuestions } = parseModelJson(completion.text);

    const citations = retrievedChunks.map((c, idx) => ({
      marker: idx + 1,
      documentId: c.documentId,
      documentName: c.documentName,
      pageNumber: c.pageNumber || 1,
      chunkId: c.chunkId,
      snippet: c.content.slice(0, 240),
      score: c.score,
    }));

    const confidenceScore = computeConfidence(retrievedChunks);

    const assistantMessage = await ChatMessage.create({
      sessionId,
      tenantId,
      userId,
      role: "ASSISTANT",
      content: answer,
      citationsJson: citations,
      confidenceScore,
      suggestedFollowUpsJson: followUpQuestions,
      provider: completion.provider,
      model: completion.model,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      latencyMs: completion.latencyMs,
      status: "SUCCESS",
    });

    await session.update({ lastMessageAt: new Date() });

    await PromptHistory.create({
      tenantId,
      userId,
      sessionId,
      feature: "CHAT",
      provider: completion.provider,
      model: completion.model,
      prompt: message,
      response: answer,
      citationsJson: citations,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      totalTokens: (completion.promptTokens || 0) + (completion.completionTokens || 0),
      latencyMs: completion.latencyMs,
      status: "SUCCESS",
    });

    return { message: assistantMessage, citations, confidenceScore, followUpQuestions };
  } catch (error) {
    const failedMessage = await ChatMessage.create({
      sessionId,
      tenantId,
      userId,
      role: "ASSISTANT",
      content: "I couldn't generate a response for that question.",
      status: "FAILED",
      errorMessage: error.message,
      latencyMs: Date.now() - start,
    });

    await PromptHistory.create({
      tenantId,
      userId,
      sessionId,
      feature: "CHAT",
      prompt: message,
      status: "FAILED",
      errorMessage: error.message,
      latencyMs: Date.now() - start,
    });

    error.chatMessage = failedMessage;
    throw error;
  }
}

module.exports = {
  createSession,
  listSessions,
  getSession,
  getMessages,
  deleteSession,
  sendMessage,
  resolveScopeDocumentIds,
};
