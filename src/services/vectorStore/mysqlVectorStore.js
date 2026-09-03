// src/services/vectorStore/mysqlVectorStore.js
//
// Default vector store — no extra infrastructure required. Embeddings are
// stored as JSON float arrays on DocumentChunk.embeddingJson and similarity
// search is a brute-force in-memory cosine comparison. This is the right
// default for MySQL-backed deployments (this project's DB dialect) and is
// perfectly fine up to tens of thousands of chunks per tenant; for larger
// corpora, switch AISettings.vectorStoreProvider to PGVECTOR/PINECONE/QDRANT.

const { DocumentChunk } = require("../../models");

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

class MySQLVectorStore {
  // chunks: [{ chunkId, embedding, provider, model }]
  static async upsert({ chunks }) {
    for (const chunk of chunks) {
      await DocumentChunk.update(
        {
          embeddingJson: chunk.embedding,
          embeddingDim: chunk.embedding.length,
          embeddingProvider: chunk.provider,
          embeddingModel: chunk.model,
        },
        { where: { id: chunk.chunkId } }
      );
    }
    return chunks.map((c) => ({ chunkId: c.chunkId, externalVectorId: null }));
  }

  static async search({ tenantId, documentIds, queryEmbedding, topK }) {
    const where = { tenantId, embeddingJson: { [require("sequelize").Op.ne]: null } };
    if (documentIds && documentIds.length) where.documentId = documentIds;

    const chunks = await DocumentChunk.findAll({ where });

    const scored = chunks
      .map((chunk) => ({
        chunkId: chunk.id,
        score: cosineSimilarity(queryEmbedding, chunk.embeddingJson || []),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  static async deleteByDocument() {
    // No-op: DocumentChunk rows themselves are deleted by the caller
    // (embeddingService), which also removes the embeddingJson with them.
    return true;
  }
}

module.exports = MySQLVectorStore;
