// src/services/ocr/engineSelector.js
// Central engine selection + fallback policy. The ONLY place that decides
// whether a billable provider may be used for a document.
const providers = require("./providers");
const settingsService = require("./ocrSettingsService");
const vault = require("./credentialVault");
const { extractWithTesseract } = require("./extractor");

class OcrEngineError extends Error {
  constructor(message, { providerError, recoverable = true } = {}) { super(message); this.name = "OcrEngineError"; this.providerError = providerError || null; this.recoverable = recoverable; }
}

/**
 * Decide and run. Returns { ocrData, engineRequested, engineUsed, fallbackUsed, providerError?, notes[] }.
 * Guarantees:
 *  - Provider is contacted at most ONCE per call (no retry loop; adapters disable SDK retries).
 *  - Provider is only used when: tenant entitled (master) AND engineMode=LICENSED AND provider enabled AND credentials present.
 *  - A failed/empty provider result never replaces anything; the caller persists only the returned result.
 *  - Fallback (if enabled) runs Tesseract exactly once and is labelled as such.
 */
async function runOcr({ models, tenantId, filePath, deps = {} }) {
  const tesseract = deps.tesseract || extractWithTesseract;
  const getProvider = deps.getProvider || providers.get;
  const notes = [];
  const row = await settingsService.loadRow(models, tenantId);

  const wantsLicensed = !!row && row.engineMode === "LICENSED" && row.isProviderEnabled && !!row.provider;
  if (!wantsLicensed) return { ocrData: await tesseract(filePath), engineRequested: "TESSERACT", engineUsed: "tesseract", fallbackUsed: false, notes };

  const ent = await settingsService.getEntitlement(tenantId);
  if (!ent.entitled) {
    // Entitlement revoked after configuration: never use the paid provider.
    notes.push("Licensed OCR is configured but not enabled for this tenant; processed with Tesseract.");
    return { ocrData: await tesseract(filePath), engineRequested: "LICENSED", engineUsed: "tesseract", fallbackUsed: true, providerError: { code: "TENANT_MODULE_NOT_ENABLED", message: "Licensed OCR is not enabled for this tenant." }, notes };
  }

  let providerError = null;
  try {
    const adapter = getProvider(row.provider);
    if (!adapter) throw Object.assign(new Error("Configured OCR provider is not supported."), { code: "INVALID_CONFIG" });
    const cfg = adapter.validateConfig(row.providerConfigJson || {});
    if (!cfg.ok) throw Object.assign(new Error("Saved provider configuration is invalid."), { code: "INVALID_CONFIG" });
    const credentials = settingsService.readCredentials(row, tenantId);
    if (!credentials) throw Object.assign(new Error("Provider credentials are missing."), { code: "CREDENTIALS_MISSING" });
    const ocrData = await adapter.process({ filePath, config: cfg.value, credentials });
    if (!ocrData || !String(ocrData.extractedText || "").trim()) throw Object.assign(new Error("Provider returned no text."), { code: "EMPTY_RESULT" });
    return { ocrData, engineRequested: "LICENSED", engineUsed: adapter.key, fallbackUsed: false, notes };
  } catch (err) {
    providerError = { code: err.code || "PROVIDER_ERROR", message: vault.redact(err.message).slice(0, 300), transient: !!err.transient };
  }

  if (row.fallbackToTesseract) {
    notes.push(`Provider failed (${providerError.code}); processed with Tesseract fallback.`);
    const ocrData = await tesseract(filePath);
    return { ocrData, engineRequested: "LICENSED", engineUsed: "tesseract", fallbackUsed: true, providerError, notes };
  }
  throw new OcrEngineError(`Licensed OCR provider failed: ${providerError.message}`, { providerError, recoverable: true });
}

module.exports = { runOcr, OcrEngineError };
