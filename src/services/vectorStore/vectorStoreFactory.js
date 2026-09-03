// src/services/vectorStore/vectorStoreFactory.js
const MySQLVectorStore = require("./mysqlVectorStore");
const PgVectorStore = require("./pgvectorStore");
const PineconeStore = require("./pineconeStore");
const QdrantStore = require("./qdrantStore");

class VectorStoreFactory {
  static getStore(vectorStoreProvider) {
    switch (vectorStoreProvider) {
      case "PGVECTOR":
        return PgVectorStore;
      case "PINECONE":
        return PineconeStore;
      case "QDRANT":
        return QdrantStore;
      case "MYSQL":
      default:
        return MySQLVectorStore;
    }
  }
}

module.exports = VectorStoreFactory;
