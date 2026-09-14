// src/services/aiProviders/geminiProvider.js
//
// Thin REST adapter over Google Gemini's generateContent + embedContent APIs.

const axios = require("axios");

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

class GeminiProvider {
  static async generateCompletion({ apiKey, baseUrl, model, messages, temperature, maxTokens }) {
    if (!apiKey) throw new Error("Gemini API key is not configured");

    const client = axios.create({ baseURL: baseUrl || DEFAULT_BASE_URL, timeout: 60000 });

    const systemInstruction = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const modelName = model || "gemini-1.5-flash";
    const { data } = await client.post(`/models/${modelName}:generateContent?key=${apiKey}`, {
      contents,
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
      generationConfig: {
        temperature: temperature ?? 0.2,
        maxOutputTokens: maxTokens || 1000,
      },
    });

    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).join("\n");

    return {
      text,
      promptTokens: data.usageMetadata?.promptTokenCount || null,
      completionTokens: data.usageMetadata?.candidatesTokenCount || null,
    };
  }

  static async generateEmbeddings({ apiKey, baseUrl, model, inputs }) {
    if (!apiKey) throw new Error("Gemini API key is not configured");

    const client = axios.create({ baseURL: baseUrl || DEFAULT_BASE_URL, timeout: 60000 });
    const modelName = model || "text-embedding-004";

    // Gemini's embedContent handles one input per call; batch sequentially.
    const embeddings = [];
    for (const input of inputs) {
      const { data } = await client.post(`/models/${modelName}:embedContent?key=${apiKey}`, {
        content: { parts: [{ text: input }] },
      });
      embeddings.push(data.embedding?.values || []);
    }

    return { embeddings, dim: embeddings[0]?.length || null };
  }
}

module.exports = GeminiProvider;
