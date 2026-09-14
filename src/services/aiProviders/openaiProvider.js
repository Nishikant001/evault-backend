// src/services/aiProviders/openaiProvider.js
//
// Thin REST adapter over OpenAI's Chat Completions + Embeddings APIs.
// Every provider adapter in this folder exposes the same two methods
// (generateCompletion, generateEmbeddings) so aiProviderService can call
// whichever one is configured without caring which vendor it is.

const axios = require("axios");

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

class OpenAIProvider {
  static async generateCompletion({ apiKey, baseUrl, model, messages, temperature, maxTokens }) {
    if (!apiKey) throw new Error("OpenAI API key is not configured");

    const client = axios.create({
      baseURL: baseUrl || DEFAULT_BASE_URL,
      timeout: 60000,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });

    const { data } = await client.post("/chat/completions", {
      model: model || "gpt-4o-mini",
      messages,
      temperature: temperature ?? 0.2,
      max_tokens: maxTokens || 1000,
    });

    return {
      text: data.choices?.[0]?.message?.content || "",
      promptTokens: data.usage?.prompt_tokens || null,
      completionTokens: data.usage?.completion_tokens || null,
    };
  }

  static async generateEmbeddings({ apiKey, baseUrl, model, inputs }) {
    if (!apiKey) throw new Error("OpenAI API key is not configured");

    const client = axios.create({
      baseURL: baseUrl || DEFAULT_BASE_URL,
      timeout: 60000,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });

    const { data } = await client.post("/embeddings", {
      model: model || "text-embedding-3-small",
      input: inputs,
    });

    const embeddings = (data.data || [])
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);

    return { embeddings, dim: embeddings[0]?.length || null };
  }
}

module.exports = OpenAIProvider;
