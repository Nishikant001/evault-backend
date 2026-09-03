// src/services/vectorStore/qdrantStore.js
//
// Optional vector store backed by Qdrant (self-hosted or Qdrant Cloud).
// Config via env vars QDRANT_URL + QDRANT_API_KEY, or per-tenant overrides
// in AISettings.vectorStoreConfigJson = { collectionName }.

const axios = require("axios");

function getClient(config = {}) {
  const url = config.url || process.env.QDRANT_URL;
  if (!url) {
    throw new Error(
      "QDRANT vector store selected but QDRANT_URL (or AISettings.vectorStoreConfigJson.url) is not configured"
    );
  }
  const apiKey = config.apiKey || process.env.QDRANT_API_KEY;
  return axios.create({
    baseURL: url.replace(/\/$/, ""),
    timeout: 30000,
    headers: { "Content-Type": "application/json", ...(apiKey ? { "api-key": apiKey } : {}) },
  });
}

async function ensureCollection(client, collectionName, dim) {
  try {
    await client.get(`/collections/${collectionName}`);
  } catch (err) {
    if (err.response && err.response.status === 404) {
      await client.put(`/collections/${collectionName}`, {
        vectors: { size: dim, distance: "Cosine" },
      });
    } else {
      throw err;
    }
  }
}

class QdrantStore {
  static async upsert({ chunks, vectorStoreConfig = {} }) {
    if (!chunks.length) return [];
    const client = getClient(vectorStoreConfig);
    const collectionName = vectorStoreConfig.collectionName || "documents";

    await ensureCollection(client, collectionName, chunks[0].embedding.length);

    await client.put(`/collections/${collectionName}/points`, {
      points: chunks.map((c) => ({
        id: c.chunkId,
        vector: c.embedding,
        payload: { tenantId: c.tenantId, documentId: c.documentId },
      })),
    });

    return chunks.map((c) => ({ chunkId: c.chunkId, externalVectorId: String(c.chunkId) }));
  }

  static async search({ tenantId, documentIds, queryEmbedding, topK, vectorStoreConfig = {} }) {
    const client = getClient(vectorStoreConfig);
    const collectionName = vectorStoreConfig.collectionName || "documents";

    const must = [{ key: "tenantId", match: { value: tenantId } }];
    if (documentIds && documentIds.length) {
      must.push({ key: "documentId", match: { any: documentIds } });
    }

    const { data } = await client.post(`/collections/${collectionName}/points/search`, {
      vector: queryEmbedding,
      limit: topK,
      filter: { must },
    });

    return (data.result || []).map((r) => ({ chunkId: Number(r.id), score: r.score }));
  }

  static async deleteByDocument({ documentId, vectorStoreConfig = {} }) {
    const client = getClient(vectorStoreConfig);
    const collectionName = vectorStoreConfig.collectionName || "documents";
    await client.post(`/collections/${collectionName}/points/delete`, {
      filter: { must: [{ key: "documentId", match: { value: documentId } }] },
    });
  }
}

module.exports = QdrantStore;
