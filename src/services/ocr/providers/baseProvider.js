// src/services/ocr/providers/baseProvider.js
// Adapter contract every licensed OCR provider implements. The OCR pipeline
// depends only on this shape, so Azure Document Intelligence (etc.) can be
// added later by implementing it and registering in providers/index.js.
//
//   key                         string, stable id persisted in ocr_settings.provider
//   displayName                 string
//   validateConfig(config)      -> { ok, errors:{field:msg}, value }   (pure, no network)
//   validateCredentials(raw)    -> { ok, errors, value }               (pure, no network)
//   testConnection({config, credentials}) -> { ok, code, message, details? }  (REAL request)
//   process({filePath, config, credentials}) -> ocrData (see extractor.summarize shape)
//
// Errors thrown/returned use ProviderError codes:
const ERROR_CODES = ["AUTH_FAILED", "PERMISSION_DENIED", "INVALID_PROCESSOR", "ENDPOINT_MISMATCH", "QUOTA_EXCEEDED", "NETWORK_TIMEOUT", "UNSUPPORTED_DOCUMENT", "INVALID_CONFIG", "PROVIDER_ERROR"];
class ProviderError extends Error {
  constructor(code, message, { transient = false } = {}) { super(message); this.name = "ProviderError"; this.code = code; this.transient = transient; }
}
module.exports = { ProviderError, ERROR_CODES };
