// src/constants/aiConstants.js
//
// Shared vocabulary for the Enterprise AI Document Assistant (RAG) module.
// Mirrors the constants pattern already used across the codebase
// (see approvalConstants.js, sapSyncConstants.js) so controllers, services
// and the frontend all agree on the same set of values.

// ── LLM providers ────────────────────────────────────────────
const AI_PROVIDERS = {
  OPENAI: "OPENAI",
  ANTHROPIC: "ANTHROPIC",
  GEMINI: "GEMINI",
  AZURE_OPENAI: "AZURE_OPENAI",
  OLLAMA: "OLLAMA",
};

const AI_PROVIDER_LIST = Object.values(AI_PROVIDERS);

// Default chat + embedding model per provider. Purely a sane fallback —
// always overridable per-tenant via AIProvider.model / AISettings.
const DEFAULT_CHAT_MODEL = {
  [AI_PROVIDERS.OPENAI]: "gpt-4o-mini",
  [AI_PROVIDERS.ANTHROPIC]: "claude-sonnet-4-6",
  [AI_PROVIDERS.GEMINI]: "gemini-1.5-flash",
  [AI_PROVIDERS.AZURE_OPENAI]: "gpt-4o-mini",
  [AI_PROVIDERS.OLLAMA]: "llama3.1",
};

const DEFAULT_EMBEDDING_MODEL = {
  [AI_PROVIDERS.OPENAI]: "text-embedding-3-small",
  [AI_PROVIDERS.ANTHROPIC]: null, // Anthropic has no embeddings endpoint — falls back to AISettings.embeddingProvider
  [AI_PROVIDERS.GEMINI]: "text-embedding-004",
  [AI_PROVIDERS.AZURE_OPENAI]: "text-embedding-3-small",
  [AI_PROVIDERS.OLLAMA]: "nomic-embed-text",
};

// ── Vector stores ────────────────────────────────────────────
const VECTOR_STORE_PROVIDERS = {
  MYSQL: "MYSQL", // default — brute-force cosine similarity over JSON-stored vectors, no extra infra required
  PGVECTOR: "PGVECTOR", // requires a separate Postgres connection (PGVECTOR_* env vars)
  PINECONE: "PINECONE",
  QDRANT: "QDRANT",
};

const VECTOR_STORE_PROVIDER_LIST = Object.values(VECTOR_STORE_PROVIDERS);

// ── Chat ──────────────────────────────────────────────────────
const CHAT_ROLES = {
  USER: "USER",
  ASSISTANT: "ASSISTANT",
  SYSTEM: "SYSTEM",
};

const CHAT_SCOPE_TYPES = {
  ALL: "ALL", // whole tenant document library (subject to RBAC-visible docs)
  DOCUMENT: "DOCUMENT", // single document
  DOCUMENT_SET: "DOCUMENT_SET", // explicit list of document IDs
  FOLDER: "FOLDER", // department/category/documentType scoped
};

// ── Indexing ──────────────────────────────────────────────────
const INDEX_STATUS = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  INDEXED: "INDEXED",
  FAILED: "FAILED",
  SKIPPED_NO_TEXT: "SKIPPED_NO_TEXT",
};

const DEFAULT_CHUNK_SIZE = 1200; // characters
const DEFAULT_CHUNK_OVERLAP = 200; // characters
const DEFAULT_TOP_K = 6;

module.exports = {
  AI_PROVIDERS,
  AI_PROVIDER_LIST,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  VECTOR_STORE_PROVIDERS,
  VECTOR_STORE_PROVIDER_LIST,
  CHAT_ROLES,
  CHAT_SCOPE_TYPES,
  INDEX_STATUS,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_TOP_K,
};
