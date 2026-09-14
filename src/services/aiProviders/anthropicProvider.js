// src/services/aiProviders/anthropicProvider.js
//
// Thin REST adapter over Anthropic's Messages API. Anthropic has no
// embeddings endpoint, so generateEmbeddings intentionally throws — the
// embedding step falls back to AISettings.defaultEmbeddingProviderId
// (see aiProviderService.resolveEmbeddingProvider), which must point at a
// provider that supports embeddings (OpenAI/Gemini/Azure/Ollama).

const axios = require("axios");

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

class AnthropicProvider {
  static async generateCompletion({ apiKey, baseUrl, model, messages, temperature, maxTokens }) {
    if (!apiKey) throw new Error("Anthropic API key is not configured");

    const client = axios.create({
      baseURL: baseUrl || DEFAULT_BASE_URL,
      timeout: 60000,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
    });

    // Anthropic separates the system prompt from the message list.
    const systemMessages = messages.filter((m) => m.role === "system").map((m) => m.content);
    const chatMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

    const { data } = await client.post("/messages", {
      model: model || "claude-sonnet-4-6",
      system: systemMessages.join("\n\n") || undefined,
      messages: chatMessages,
      temperature: temperature ?? 0.2,
      max_tokens: maxTokens || 1000,
    });

    const text = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      text,
      promptTokens: data.usage?.input_tokens || null,
      completionTokens: data.usage?.output_tokens || null,
    };
  }

  static async generateEmbeddings() {
    throw new Error(
      "Anthropic does not provide an embeddings API. Configure a separate embedding provider (OpenAI/Gemini/Azure/Ollama) in AI Settings."
    );
  }
}

module.exports = AnthropicProvider;
