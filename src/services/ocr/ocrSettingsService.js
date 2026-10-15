// src/services/ocr/ocrSettingsService.js
// Tenant OCR configuration: load/save with masking, entitlement, encrypted credentials.
const providers = require("./providers");
const vault = require("./credentialVault");
const tenantModuleService = require("../tenantModuleService");

const MODULE_KEY = "licensed_ocr";

async function getEntitlement(tenantId) {
  const r = await tenantModuleService.assertTenantModule(tenantId, MODULE_KEY);
  return { entitled: !!r.allowed, reason: r.allowed ? null : r.reason };
}

async function loadRow(models, tenantId) {
  return models.OcrSettings.findOne({ where: { tenantId } });
}

// Public (browser-safe) view. NEVER includes credentialsEncrypted or any decrypted value.
function toPublic(row, entitlement) {
  const base = {
    entitled: entitlement.entitled,
    entitlementReason: entitlement.reason,
    encryptionConfigured: vault.isConfigured(),
    availableProviders: entitlement.entitled ? providers.list() : [],
    freeEngine: { key: "TESSERACT", available: true },
  };
  if (!row) return { ...base, configured: false, engineMode: "TESSERACT", provider: null, isProviderEnabled: false, fallbackToTesseract: true, providerConfig: {}, credentials: { stored: false, maskedLabel: null, updatedAt: null }, lastTest: null };
  const cfg = row.providerConfigJson || {};
  return {
    ...base, configured: true, engineMode: row.engineMode, provider: row.provider, isProviderEnabled: !!row.isProviderEnabled,
    fallbackToTesseract: !!row.fallbackToTesseract, providerConfig: cfg,
    credentials: { stored: !!row.credentialsEncrypted, maskedLabel: row.credentialsEncrypted ? "••••••••  (stored securely)" : null, updatedAt: row.credentialsUpdatedAt },
    lastTest: row.lastTestAt ? { status: row.lastTestStatus, message: row.lastTestMessage, at: row.lastTestAt, lastSuccessAt: row.lastSuccessfulTestAt } : (row.lastSuccessfulTestAt ? { status: null, message: null, at: null, lastSuccessAt: row.lastSuccessfulTestAt } : null),
  };
}

async function getPublicSettings(models, tenantId) {
  const [row, ent] = await Promise.all([loadRow(models, tenantId), getEntitlement(tenantId)]);
  return toPublic(row, ent);
}

/**
 * input: { engineMode, provider, isProviderEnabled, fallbackToTesseract, providerConfig, credentials?, clearCredentials? }
 * Returns { ok, status, errors?, settings? }. All validation is server-side.
 */
async function saveSettings(models, tenantId, userId, input = {}) {
  const ent = await getEntitlement(tenantId);
  const row = await loadRow(models, tenantId);
  const errors = {};
  const engineMode = input.engineMode === "LICENSED" ? "LICENSED" : "TESSERACT";
  const fallbackToTesseract = input.fallbackToTesseract === undefined ? (row ? !!row.fallbackToTesseract : true) : !!input.fallbackToTesseract;
  const update = { tenantId, engineMode, fallbackToTesseract, updatedBy: userId };

  const touchesLicensed = engineMode === "LICENSED" || input.provider || input.credentials || input.clearCredentials || input.isProviderEnabled || input.providerConfig;
  if (touchesLicensed && !ent.entitled) {
    return { ok: false, status: 403, code: "TENANT_MODULE_NOT_ENABLED", message: "Licensed OCR is not enabled for your organisation. Contact your administrator." };
  }

  if (ent.entitled && (input.provider || engineMode === "LICENSED" || (row && row.provider))) {
    const providerKey = input.provider || (row && row.provider);
    const adapter = providers.get(providerKey);
    if (!adapter) errors.provider = "Unsupported provider.";
    else {
      update.provider = providerKey;
      const cfgIn = input.providerConfig !== undefined ? input.providerConfig : (row && row.providerConfigJson) || {};
      const cfg = adapter.validateConfig(cfgIn);
      if (!cfg.ok && (engineMode === "LICENSED" || input.isProviderEnabled || input.providerConfig !== undefined)) Object.assign(errors, cfg.errors);
      if (cfg.ok) update.providerConfigJson = cfg.value;

      if (input.clearCredentials) { update.credentialsEncrypted = null; update.credentialsUpdatedAt = new Date(); update.isProviderEnabled = false; }
      else if (input.credentials !== undefined && input.credentials !== null && input.credentials !== "") {
        const cred = adapter.validateCredentials(input.credentials);
        if (!cred.ok) Object.assign(errors, cred.errors);
        else {
          try { update.credentialsEncrypted = vault.encrypt(JSON.stringify(cred.value), tenantId); update.credentialsUpdatedAt = new Date(); }
          catch (e) { return { ok: false, status: 503, code: e.code || "VAULT_ERROR", message: e.message }; }
        }
      }
      const hasCreds = update.credentialsEncrypted !== undefined ? !!update.credentialsEncrypted : !!(row && row.credentialsEncrypted);
      const wantsEnabled = input.clearCredentials ? false : (input.isProviderEnabled !== undefined ? !!input.isProviderEnabled : (row ? !!row.isProviderEnabled : false));
      if (wantsEnabled && !hasCreds) errors.credentials = "Credentials are required before the provider can be enabled.";
      if (engineMode === "LICENSED" && !hasCreds) errors.credentials = errors.credentials || "Credentials are required to use the licensed engine.";
      if (engineMode === "LICENSED" && !wantsEnabled && !input.clearCredentials) errors.isProviderEnabled = "Enable the provider to select the licensed engine.";
      if (update.isProviderEnabled === undefined) update.isProviderEnabled = wantsEnabled;
      // Any config/credential change invalidates the previous connection test result.
      if (input.credentials || input.clearCredentials || (cfg.ok && row && JSON.stringify(row.providerConfigJson || {}) !== JSON.stringify(cfg.value))) { update.lastTestStatus = null; update.lastTestMessage = null; update.lastTestAt = null; update.lastSuccessfulTestAt = null; }
    }
  }
  if (Object.keys(errors).length) return { ok: false, status: 400, code: "VALIDATION_ERROR", message: "Please correct the highlighted fields.", errors };

  if (engineMode === "TESSERACT") update.engineMode = "TESSERACT";
  if (row) await row.update(update); else await models.OcrSettings.create(update);
  return { ok: true, status: 200, settings: await getPublicSettings(models, tenantId) };
}

// Decrypted credentials — server-internal only.
function readCredentials(row, tenantId) {
  if (!row || !row.credentialsEncrypted) return null;
  return JSON.parse(vault.decrypt(row.credentialsEncrypted, tenantId));
}

async function testConnection(models, tenantId, { adapterOverride } = {}) {
  const ent = await getEntitlement(tenantId);
  if (!ent.entitled) return { ok: false, status: 403, code: "TENANT_MODULE_NOT_ENABLED", message: "Licensed OCR is not enabled for your organisation." };
  const row = await loadRow(models, tenantId);
  if (!row || !row.provider) return { ok: false, status: 400, code: "NOT_CONFIGURED", message: "No provider is configured yet. Save the configuration first." };
  const adapter = adapterOverride || providers.get(row.provider);
  if (!adapter) return { ok: false, status: 400, code: "INVALID_CONFIG", message: "Unsupported provider." };
  let credentials;
  try { credentials = readCredentials(row, tenantId); } catch (e) { return { ok: false, status: 400, code: e.code || "CREDENTIALS_UNREADABLE", message: e.message }; }
  if (!credentials) return { ok: false, status: 400, code: "CREDENTIALS_MISSING", message: "Credentials have not been saved." };
  const cfg = adapter.validateConfig(row.providerConfigJson || {});
  if (!cfg.ok) return { ok: false, status: 400, code: "INVALID_CONFIG", message: "Saved provider configuration is invalid.", errors: cfg.errors };
  const result = await adapter.testConnection({ config: cfg.value, credentials });
  const now = new Date();
  await row.update({ lastTestStatus: result.code, lastTestMessage: vault.redact(result.message).slice(0, 500), lastTestAt: now, lastSuccessfulTestAt: result.ok ? now : row.lastSuccessfulTestAt });
  return { ok: result.ok, status: 200, code: result.code, message: vault.redact(result.message), testedAt: now };
}

module.exports = { MODULE_KEY, getEntitlement, getPublicSettings, saveSettings, testConnection, readCredentials, loadRow, toPublic };
