// src/controllers/ocrSettingsController.js
// Tenant is ALWAYS taken from the authenticated token (req.user.tenantId),
// never from params/body. Credentials are write-only: no endpoint returns them.
const settingsService = require("../services/ocr/ocrSettingsService");
const vault = require("../services/ocr/credentialVault");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

function tenantOf(req) {
  const tenantId = req.user && req.user.tenantId;
  if (!tenantId || !req.models || !req.models.OcrSettings) { const e = new Error("Tenant context required"); e.statusCode = 403; throw e; }
  return tenantId;
}
const fail = (res, error) => {
  const status = error.statusCode || 500;
  if (status >= 500) console.error("[ocrSettings]", vault.redact(error.message));
  return res.status(status).json({ success: false, message: status >= 500 ? "Unable to process OCR settings request" : vault.redact(error.message) });
};

const getSettings = async (req, res) => {
  try { const tenantId = tenantOf(req); return res.json({ success: true, data: await settingsService.getPublicSettings(req.models, tenantId) }); }
  catch (e) { return fail(res, e); }
};

const saveSettings = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    // tenantId in the body is ignored on purpose.
    const result = await settingsService.saveSettings(req.models, tenantId, req.user.id, {
      engineMode: body.engineMode, provider: body.provider, isProviderEnabled: body.isProviderEnabled,
      fallbackToTesseract: body.fallbackToTesseract, providerConfig: body.providerConfig, credentials: body.credentials, clearCredentials: body.clearCredentials === true,
    });
    await AuditService.log({ req, module: AUDIT_MODULES.OCR, action: result.ok ? AUDIT_ACTIONS.OCR_SETTINGS_UPDATED : AUDIT_ACTIONS.OCR_SETTINGS_UPDATED,
      // never audit credentials: only which non-secret aspects changed
      newValue: { engineMode: body.engineMode, provider: body.provider, credentialsReplaced: !!body.credentials, credentialsCleared: body.clearCredentials === true },
      remarks: result.ok ? "OCR settings updated" : `OCR settings update rejected (${result.code})`, status: result.ok ? AUDIT_STATUS.SUCCESS : AUDIT_STATUS.FAILED });
    if (!result.ok) return res.status(result.status).json({ success: false, code: result.code, message: result.message, errors: result.errors });
    return res.json({ success: true, data: result.settings });
  } catch (e) { return fail(res, e); }
};

const testConnection = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const result = await settingsService.testConnection(req.models, tenantId);
    await AuditService.log({ req, module: AUDIT_MODULES.OCR, action: AUDIT_ACTIONS.OCR_PROVIDER_TESTED, remarks: `OCR provider connection test: ${result.code}`, status: result.ok ? AUDIT_STATUS.SUCCESS : AUDIT_STATUS.FAILED });
    // A failed *provider* test is a normal outcome (HTTP 200, ok:false); config/entitlement problems use 4xx.
    if (result.status && result.status !== 200) return res.status(result.status).json({ success: false, code: result.code, message: result.message, errors: result.errors });
    return res.json({ success: true, data: { connected: result.ok, code: result.code, message: result.message, testedAt: result.testedAt } });
  } catch (e) { return fail(res, e); }
};

const clearCredentials = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const result = await settingsService.saveSettings(req.models, tenantId, req.user.id, { clearCredentials: true, engineMode: "TESSERACT" });
    await AuditService.log({ req, module: AUDIT_MODULES.OCR, action: AUDIT_ACTIONS.OCR_PROVIDER_CREDENTIALS_CLEARED, remarks: "OCR provider credentials cleared", status: result.ok ? AUDIT_STATUS.SUCCESS : AUDIT_STATUS.FAILED });
    if (!result.ok) return res.status(result.status).json({ success: false, code: result.code, message: result.message });
    return res.json({ success: true, data: result.settings });
  } catch (e) { return fail(res, e); }
};

module.exports = { getSettings, saveSettings, testConnection, clearCredentials };
