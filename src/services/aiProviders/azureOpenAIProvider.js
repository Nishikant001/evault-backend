// src/services/aiProviders/azureOpenAIProvider.js
//
// Thin REST adapter over an Azure OpenAI resource. Azure's URL scheme is
// per-deployment, so `model` here is treated as the DEPLOYMENT NAME
// (Azure OpenAI convention), and `baseUrl` must be the resource endpoint,
// e.g. https://<resource>.openai.azure.com

const axios = require("axios");

class AzureOpenAIProvider {
  static async generateCompletion({ apiKey, baseUrl, model, apiVersion, messages, temperature, maxTokens }) {
    if (!apiKey) throw new Error("Azure OpenAI API key is not configured");
    if (!baseUrl) throw new Error("Azure OpenAI baseUrl (resource endpoint) is not configured");
    if (!model) throw new Error("Azure OpenAI deployment name (chatModel) is not configured");

    const client = axios.create({
      baseURL: baseUrl.replace(/\/$/, ""),
      timeout: 60000,
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
    });

    const version = apiVersion || "2024-06-01";
    const { data } = await client.post(
      `/openai/deployments/${model}/chat/completions?api-version=${version}`,
      { messages, temperature: temperature ?? 0.2, max_tokens: maxTokens || 1000 }
    );

    return {
      text: data.choices?.[0]?.message?.content || "",
      promptTokens: data.usage?.prompt_tokens || null,
      completionTokens: data.usage?.completion_tokens || null,
    };
  }

  static async generateEmbeddings({ apiKey, baseUrl, model, apiVersion, inputs }) {
    if (!apiKey) throw new Error("Azure OpenAI API key is not configured");
    if (!baseUrl) throw new Error("Azure OpenAI baseUrl (resource endpoint) is not configured");
    if (!model) throw new Error("Azure OpenAI embedding deployment name is not configured");

    const client = axios.create({
      baseURL: baseUrl.replace(/\/$/, ""),
      timeout: 60000,
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
    });

    const version = apiVersion || "2024-06-01";
    const { data } = await client.post(
      `/openai/deployments/${model}/embeddings?api-version=${version}`,
      { input: inputs }
    );

    const embeddings = (data.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { embeddings, dim: embeddings[0]?.length || null };
  }
}

module.exports = AzureOpenAIProvider;
