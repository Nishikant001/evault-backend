// src/controllers/aiSettingsController.js
const aiProviderService = require("../services/aiProviderService");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

const listProviders = async (req, res) => {
  try {
    const providers = await aiProviderService.listProviders(req.user.tenantId);
    return res.json({ success: true, data: providers });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const createProvider = async (req, res) => {
  try {
    const { name, providerType, apiKey, baseUrl, chatModel, embeddingModel, apiVersion, extraConfigJson, isDefault } = req.body;
    if (!name || !providerType) {
      return res.status(400).json({ success: false, message: "name and providerType are required" });
    }

    const provider = await aiProviderService.createProvider({
      tenantId: req.user.tenantId,
      name,
      providerType,
      apiKey,
      baseUrl,
      chatModel,
      embeddingModel,
      apiVersion,
      extraConfigJson,
      isDefault,
      createdBy: req.user.id,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.AI_ASSISTANT,
      action: AUDIT_ACTIONS.AI_PROVIDER_CREATED,
      newValue: { id: provider.id, providerType },
      remarks: `Configured AI provider "${name}" (${providerType})`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({ success: true, data: provider });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const updateProvider = async (req, res) => {
  try {
    const provider = await aiProviderService.updateProvider(req.params.id, req.user.tenantId, req.body);

    await AuditService.log({
      req,
      module: AUDIT_MODULES.AI_ASSISTANT,
      action: AUDIT_ACTIONS.AI_PROVIDER_UPDATED,
      newValue: { id: provider.id },
      remarks: `Updated AI provider #${provider.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: provider });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const deleteProvider = async (req, res) => {
  try {
    const result = await aiProviderService.deleteProvider(req.params.id, req.user.tenantId);

    await AuditService.log({
      req,
      module: AUDIT_MODULES.AI_ASSISTANT,
      action: AUDIT_ACTIONS.AI_PROVIDER_DELETED,
      newValue: result,
      remarks: `Deleted AI provider #${result.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const getSettings = async (req, res) => {
  try {
    const settings = await aiProviderService.getOrCreateSettings(req.user.tenantId);
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const updateSettings = async (req, res) => {
  try {
    const settings = await aiProviderService.updateSettings(req.user.tenantId, req.body);

    await AuditService.log({
      req,
      module: AUDIT_MODULES.AI_ASSISTANT,
      action: AUDIT_ACTIONS.AI_SETTINGS_UPDATED,
      newValue: req.body,
      remarks: "Updated tenant AI settings",
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

module.exports = { listProviders, createProvider, updateProvider, deleteProvider, getSettings, updateSettings };
