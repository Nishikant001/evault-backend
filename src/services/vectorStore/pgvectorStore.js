// src/services/vectorStore/pgvectorStore.js
//
// Optional vector store for tenants who run a separate Postgres instance
// with the `vector` extension enabled. This project's primary DB is MySQL
// (see src/config/database.js), so pgvector is intentionally NOT the
// default — it requires its own connection, configured via env vars:
//   PGVECTOR_HOST, PGVECTOR_PORT, PGVECTOR_DB, PGVECTOR_USER, PGVECTOR_PASSWORD
//
// The `pg` package is required lazily so it is not a hard dependency for
// tenants who never select PGVECTOR as their vector store provider.

let pool = null;

function getPool() {
  if (pool) return pool;
  let Pool;
  try {
    ({ Pool } = require("pg"));
  } catch (err) {
    throw new Error(
      "PGVECTOR vector store selected but the 'pg' package is not installed. Run: npm install pg"
    );
  }

  pool = new Pool({
    host: process.env.PGVECTOR_HOST,
    port: process.env.PGVECTOR_PORT || 5432,
    database: process.env.PGVECTOR_DB,
    user: process.env.PGVECTOR_USER,
    password: process.env.PGVECTOR_PASSWORD,
  });
  return pool;
}

async function ensureSchema(client, dim) {
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  await client.query(`
    CREATE TABLE IF NOT EXISTS document_vectors (
      chunk_id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      document_id INTEGER NOT NULL,
      embedding vector(${dim})
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_document_vectors_tenant ON document_vectors (tenant_id)"
  );
}

class PgVectorStore {
  // chunks: [{ chunkId, tenantId, documentId, embedding, provider, model }]
  static async upsert({ chunks }) {
    if (!chunks.length) return [];
    const client = await getPool().connect();
    try {
      const dim = chunks[0].embedding.length;
      await ensureSchema(client, dim);

      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO document_vectors (chunk_id, tenant_id, document_id, embedding)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [chunk.chunkId, chunk.tenantId, chunk.documentId, `[${chunk.embedding.join(",")}]`]
        );
      }

      return chunks.map((c) => ({ chunkId: c.chunkId, externalVectorId: String(c.chunkId) }));
    } finally {
      client.release();
    }
  }

  static async search({ tenantId, documentIds, queryEmbedding, topK }) {
    const client = await getPool().connect();
    try {
      const vectorLiteral = `[${queryEmbedding.join(",")}]`;
      const params = [vectorLiteral, tenantId];
      let filter = "tenant_id = $2";
      if (documentIds && documentIds.length) {
        params.push(documentIds);
        filter += ` AND document_id = ANY($3::int[])`;
      }
      params.push(topK);

      const { rows } = await client.query(
        `SELECT chunk_id, 1 - (embedding <=> $1) AS score
         FROM document_vectors
         WHERE ${filter}
         ORDER BY embedding <=> $1
         LIMIT $${params.length}`,
        params
      );

      return rows.map((r) => ({ chunkId: r.chunk_id, score: r.score }));
    } finally {
      client.release();
    }
  }

  static async deleteByDocument({ documentId }) {
    const client = await getPool().connect();
    try {
      await client.query("DELETE FROM document_vectors WHERE document_id = $1", [documentId]);
    } finally {
      client.release();
    }
  }
}

module.exports = PgVectorStore;
