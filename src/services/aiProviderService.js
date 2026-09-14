// src/services/aiProviderService.js
//
// Central entry point for everything provider-related:
//   - CRUD for AIProvider (tenant-scoped credentials) and AISettings
//   - Resolving which provider a tenant should use for chat vs. embeddings
//   - Actually invoking the resolved provider via aiProviderFactory
//
// Resolution order for a tenant (chat or embedding, same logic):
//   1. AISettings.defaultChatProviderId / defaultEmbeddingProviderId, if set and active
//   2. The tenant's own AIProvider row of the right capability (isDefault=true, else newest)
//   3. A platform-wide AIProvider row (tenantId = null) configured by SuperAdmin
//   4. Environment variables (AI_DEFAULT_PROVIDER / OPENAI_API_KEY / etc.) — lets the
//      module work out of the box in dev/demo environments with zero DB setup.

// PHASE G — AIProvider/AISettings are tenant-side models. Every function
// below already takes `tenantId` as an argument, so each resolves its
// OWN tenant connection via the same cache every HTTP request uses,
// instead of a static top-level legacy import.
const { getTenantConnection } = require("./tenantConnectionManager");
const AIProviderFactory = require("./aiProviderFactory");
const cryptoUtil = require("../utils/cryptoUtil");
const {
  AI_PROVIDER_LIST,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
} = require("../constants/aiConstants");

function toPublicProvider(provider) {
  if (!provider) return null;
  const json = provider.toJSON ? provider.toJSON() : provider;
  return {
    ...json,
    apiKeyEncrypted: undefined,
    apiKeyMasked: cryptoUtil.mask(cryptoUtil.decrypt(json.apiKeyEncrypted)),
  };
}

// ── AIProvider CRUD ─────────────────────────────────────────────
async function createProvider({ tenantId, name, providerType, apiKey, baseUrl, chatModel, embeddingModel, apiVersion, extraConfigJson, isDefault, createdBy }) {
  const { AIProvider } = (await getTenantConnection(tenantId)).models;
  if (!AI_PROVIDER_LIST.includes(providerType)) {
    const err = new Error(`Invalid providerType. Must be one of: ${AI_PROVIDER_LIST.join(", ")}`);
    err.statusCode = 400;
    throw err;
  }

  if (isDefault) {
    await AIProvider.update({ isDefault: false }, { where: { tenantId } });
  }

  const provider = await AIProvider.create({
    tenantId,
    name,
    providerType,
    apiKeyEncrypted: cryptoUtil.encrypt(apiKey),
    baseUrl: baseUrl || null,
    chatModel: chatModel || DEFAULT_CHAT_MODEL[providerType] || null,
    embeddingModel: embeddingModel || DEFAULT_EMBEDDING_MODEL[providerType] || null,
    apiVersion: apiVersion || null,
    extraConfigJson: extraConfigJson || null,
    isDefault: !!isDefault,
    createdBy,
  });

  return toPublicProvider(provider);
}

async function listProviders(tenantId) {
  const { AIProvider } = (await getTenantConnection(tenantId)).models;
  const providers = await AIProvider.findAll({
    where: { tenantId },
    order: [["createdAt", "DESC"]],
  });
  return providers.map(toPublicProvider);
}

async function getProviderRaw(id, tenantId) {
  const { AIProvider } = (await getTenantConnection(tenantId)).models;
  const provider = await AIProvider.findOne({ where: { id, tenantId } });
  if (!provider) {
    const err = new Error("AI provider not found");
    err.statusCode = 404;
    throw err;
  }
  return provider;
}

async function updateProvider(id, tenantId, updates) {
  const { AIProvider } = (await getTenantConnection(tenantId)).models;
  const provider = await getProviderRaw(id, tenantId);

  if (updates.isDefault) {
    await AIProvider.update({ isDefault: false }, { where: { tenantId } });
  }

  const patch = { ...updates };
  if (Object.prototype.hasOwnProperty.call(updates, "apiKey")) {
    patch.apiKeyEncrypted = cryptoUtil.encrypt(updates.apiKey);
    delete patch.apiKey;
  }

  await provider.update(patch);
  return toPublicProvider(provider);
}

async function deleteProvider(id, tenantId) {
  const provider = await getProviderRaw(id, tenantId);
  await provider.destroy();
  return { id };
}

// ── AISettings ───────────────────────────────────────────────────
async function getOrCreateSettings(tenantId) {
  const { AISettings } = (await getTenantConnection(tenantId)).models;
  let settings = await AISettings.findOne({ where: { tenantId } });
  if (!settings) {
    settings = await AISettings.create({ tenantId });
  }
  return settings;
}

async function updateSettings(tenantId, updates) {
  const settings = await getOrCreateSettings(tenantId);
  await settings.update(updates);
  return settings;
}

// ── Resolution ───────────────────────────────────────────────────
// capability: "chat" | "embedding"
// NOTE on the tenantId:null "platform-wide" fallback below: now that
// AIProvider lives in each tenant's OWN physical database (see
// PHASE_F_MIGRATION_REPORT.md), a tenantId:null row can only ever be
// SEEDED per-tenant (e.g. by a provisioning script), not genuinely
// shared across tenants the way it could be on the old shared DB. The
// resolution order/behavior itself is unchanged from before this phase
// — this is a structural consequence of the multi-tenant-DB
// architecture (already decided in Phase B/C), not something redesigned
// here.
async function resolveProvider(tenantId, capability = "chat") {
  const { AIProvider } = (await getTenantConnection(tenantId)).models;
  const settings = await getOrCreateSettings(tenantId);
  const preferredId =
    capability === "embedding" ? settings.defaultEmbeddingProviderId : settings.defaultChatProviderId;

  let provider = null;

  if (preferredId) {
    provider = await AIProvider.findOne({ where: { id: preferredId, isActive: true } });
  }

  if (!provider) {
    provider = await AIProvider.findOne({
      where: { tenantId, isActive: true },
      order: [
        ["isDefault", "DESC"],
        ["createdAt", "DESC"],
      ],
    });
  }

  if (!provider) {
    // platform-wide fallback configured by SuperAdmin (tenantId = null)
    provider = await AIProvider.findOne({
      where: { tenantId: null, isActive: true },
      order: [
        ["isDefault", "DESC"],
        ["createdAt", "DESC"],
      ],
    });
  }

  if (provider) {
    return {
      providerType: provider.providerType,
      apiKey: cryptoUtil.decrypt(provider.apiKeyEncrypted),
      baseUrl: provider.baseUrl,
      apiVersion: provider.apiVersion,
      model: capability === "embedding" ? provider.embeddingModel : provider.chatModel,
      extraConfig: provider.extraConfigJson || {},
      source: "db",
    };
  }

  // ── Environment-variable fallback (zero-config dev/demo path) ──
  const envProviderType = (process.env.AI_DEFAULT_PROVIDER || "OPENAI").toUpperCase();
  if (!AI_PROVIDER_LIST.includes(envProviderType)) return null;

  const envKeyMap = {
    OPENAI: process.env.OPENAI_API_KEY,
    ANTHROPIC: process.env.ANTHROPIC_API_KEY,
    GEMINI: process.env.GEMINI_API_KEY,
    AZURE_OPENAI: process.env.AZURE_OPENAI_API_KEY,
    OLLAMA: "not-required",
  };
  const apiKey = envKeyMap[envProviderType];
  if (!apiKey) return null;

  return {
    providerType: envProviderType,
    apiKey: envProviderType === "OLLAMA" ? null : apiKey,
    baseUrl: process.env.AI_DEFAULT_BASE_URL || null,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || null,
    model:
      capability === "embedding"
        ? process.env.AI_DEFAULT_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL[envProviderType]
        : process.env.AI_DEFAULT_CHAT_MODEL || DEFAULT_CHAT_MODEL[envProviderType],
    extraConfig: {},
    source: "env",
  };
}

async function callChat(tenantId, messages, opts = {}) {
  const resolved = await resolveProvider(tenantId, "chat");
  if (!resolved) {
    const err = new Error(
      "No AI chat provider is configured for this tenant. Ask a Tenant Admin to add one under AI Settings."
    );
    err.statusCode = 422;
    throw err;
  }

  const adapter = AIProviderFactory.getAdapter(resolved.providerType);
  const start = Date.now();
  const result = await adapter.generateCompletion({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    apiVersion: resolved.apiVersion,
    model: resolved.model,
    messages,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
  });

  return {
    ...result,
    provider: resolved.providerType,
    model: resolved.model,
    latencyMs: Date.now() - start,
  };
}

async function callEmbeddings(tenantId, texts) {
  let resolved = await resolveProvider(tenantId, "embedding");

  // Anthropic has no embeddings API — if that's what got resolved, fall
  // back to whatever the chat provider is, only if it can embed.
  if (resolved && resolved.providerType === "ANTHROPIC") {
    resolved = await resolveProvider(tenantId, "chat");
    if (resolved && resolved.providerType === "ANTHROPIC") resolved = null;
  }

  if (!resolved) {
    const err = new Error(
      "No AI embedding provider is configured for this tenant. Configure OpenAI/Gemini/Azure OpenAI/Ollama under AI Settings."
    );
    err.statusCode = 422;
    throw err;
  }

  const adapter = AIProviderFactory.getAdapter(resolved.providerType);
  const result = await adapter.generateEmbeddings({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    apiVersion: resolved.apiVersion,
    model: resolved.model,
    inputs: texts,
  });

  return { ...result, provider: resolved.providerType, model: resolved.model };
}

module.exports = {
  createProvider,
  listProviders,
  getProviderRaw,
  updateProvider,
  deleteProvider,
  getOrCreateSettings,
  updateSettings,
  resolveProvider,
  callChat,
  callEmbeddings,
  toPublicProvider,
};
