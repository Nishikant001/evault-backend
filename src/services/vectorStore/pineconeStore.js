// src/services/vectorStore/pineconeStore.js
//
// Optional vector store backed by Pinecone (managed, serverless). Config
// via env vars PINECONE_API_KEY + PINECONE_INDEX_HOST, or per-tenant
// overrides in AISettings.vectorStoreConfigJson = { indexHost, namespace }.
// Each Document's chunks are upserted with id = String(chunkId) so search
// results map straight back to DocumentChunk rows with no extra lookup table.

const axios = require("axios");

function getClient(config = {}) {
  const apiKey = config.apiKey || process.env.PINECONE_API_KEY;
  const indexHost = config.indexHost || process.env.PINECONE_INDEX_HOST;
  if (!apiKey || !indexHost) {
    throw new Error(
      "PINECONE vector store selected but PINECONE_API_KEY / PINECONE_INDEX_HOST (or AISettings.vectorStoreConfigJson.indexHost) are not configured"
    );
  }
  return axios.create({
    baseURL: `https://${indexHost.replace(/^https?:\/\//, "")}`,
    timeout: 30000,
    headers: { "Api-Key": apiKey, "Content-Type": "application/json" },
  });
}

class PineconeStore {
  static async upsert({ chunks, vectorStoreConfig = {} }) {
    if (!chunks.length) return [];
    const client = getClient(vectorStoreConfig);
    const namespace = vectorStoreConfig.namespace || "default";

    await client.post("/vectors/upsert", {
      namespace,
      vectors: chunks.map((c) => ({
        id: String(c.chunkId),
        values: c.embedding,
        metadata: { tenantId: c.tenantId, documentId: c.documentId },
      })),
    });

    return chunks.map((c) => ({ chunkId: c.chunkId, externalVectorId: String(c.chunkId) }));
  }

  static async search({ tenantId, documentIds, queryEmbedding, topK, vectorStoreConfig = {} }) {
    const client = getClient(vectorStoreConfig);
    const namespace = vectorStoreConfig.namespace || "default";

    const filter = { tenantId: { $eq: tenantId } };
    if (documentIds && documentIds.length) filter.documentId = { $in: documentIds };

    const { data } = await client.post("/query", {
      namespace,
      vector: queryEmbedding,
      topK,
      filter,
      includeMetadata: false,
    });

    return (data.matches || []).map((m) => ({ chunkId: Number(m.id), score: m.score }));
  }

  static async deleteByDocument({ documentId, vectorStoreConfig = {} }) {
    const client = getClient(vectorStoreConfig);
    const namespace = vectorStoreConfig.namespace || "default";
    await client.post("/vectors/delete", { namespace, filter: { documentId: { $eq: documentId } } });
  }
}

module.exports = PineconeStore;
