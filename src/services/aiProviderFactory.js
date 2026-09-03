// src/services/aiProviderFactory.js
// Mirrors the existing erpFactory.js pattern: one switch that maps a type
// string to the concrete adapter implementing { generateCompletion, generateEmbeddings }.

const OpenAIProvider = require("./aiProviders/openaiProvider");
const AnthropicProvider = require("./aiProviders/anthropicProvider");
const GeminiProvider = require("./aiProviders/geminiProvider");
const AzureOpenAIProvider = require("./aiProviders/azureOpenAIProvider");
const OllamaProvider = require("./aiProviders/ollamaProvider");

class AIProviderFactory {
  static getAdapter(providerType) {
    switch (providerType) {
      case "OPENAI":
        return OpenAIProvider;
      case "ANTHROPIC":
        return AnthropicProvider;
      case "GEMINI":
        return GeminiProvider;
      case "AZURE_OPENAI":
        return AzureOpenAIProvider;
      case "OLLAMA":
        return OllamaProvider;
      default:
        throw new Error(`Unsupported AI provider type: ${providerType}`);
    }
  }
}

module.exports = AIProviderFactory;
