// src/services/aiProviders/ollamaProvider.js
//
// Thin REST adapter over a locally-running Ollama server (fully offline,
// no API key required). baseUrl defaults to the standard local port.

const axios = require("axios");

const DEFAULT_BASE_URL = "http://localhost:11434";

class OllamaProvider {
  static async generateCompletion({ baseUrl, model, messages, temperature, maxTokens }) {
    const client = axios.create({ baseURL: baseUrl || DEFAULT_BASE_URL, timeout: 120000 });

    const { data } = await client.post("/api/chat", {
      model: model || "llama3.1",
      messages,
      stream: false,
      options: { temperature: temperature ?? 0.2, num_predict: maxTokens || 1000 },
    });

    return {
      text: data.message?.content || "",
      promptTokens: data.prompt_eval_count || null,
      completionTokens: data.eval_count || null,
    };
  }

  static async generateEmbeddings({ baseUrl, model, inputs }) {
    const client = axios.create({ baseURL: baseUrl || DEFAULT_BASE_URL, timeout: 120000 });
    const modelName = model || "nomic-embed-text";

    const embeddings = [];
    for (const input of inputs) {
      const { data } = await client.post("/api/embeddings", { model: modelName, prompt: input });
      embeddings.push(data.embedding || []);
    }

    return { embeddings, dim: embeddings[0]?.length || null };
  }
}

module.exports = OllamaProvider;
