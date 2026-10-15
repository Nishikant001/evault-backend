// PHASE G — ErpConfig is a Master DB model.
const masterModels = require("../models/masterDb");
const ErpFactory = require("../services/erpFactory");
const SapMetadataService = require("../services/sapMetadataService");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const { encryptSecret } = require("../services/erpCredentialService");
const {
  PROTOCOLS,
  AUTH_TYPES,
  validateConnectorConfig,
  computeCapabilities,
  defaultConnectorConfig,
  describeSchema,
  normalizeErpType,
  defaultProtocolFor,
} = require("../services/connector/connectorSchema");

// DYNAMIC ERP CONNECTOR (Step 1) ───────────────────────────────────────
// Shared by create + update. Returns { error } (400 body) or the cleaned
// values to persist. `current` is the existing row on update.
function resolveConnectorFields(body, current) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  let erpType = current ? current.erpType : undefined;
  if (has("erpType") || !current) {
    erpType = normalizeErpType(body.erpType);
    if (!erpType) {
      return { error: { message: "erpType must be 2-50 characters: letters, digits or underscore, starting with a letter" } };
    }
    out.erpType = erpType;
  }

  let protocol = current ? current.protocol : undefined;
  if (has("protocol")) protocol = body.protocol;
  else if (!current || has("erpType")) protocol = protocol || defaultProtocolFor(erpType);
  if (!PROTOCOLS.includes(protocol)) {
    return { error: { message: `protocol must be one of: ${PROTOCOLS.join(", ")}` } };
  }
  if (!current || has("protocol") || has("erpType")) out.protocol = protocol;

  if (has("authType") && body.authType !== null && !AUTH_TYPES.includes(body.authType)) {
    return { error: { message: `authType must be one of: ${AUTH_TYPES.join(", ")}` } };
  }

  if (has("templateKey")) out.templateKey = body.templateKey || null;

  if (has("connectorConfig")) {
    if (body.connectorConfig === null) {
      out.connectorConfig = null;
    } else {
      const result = validateConnectorConfig(protocol, body.connectorConfig);
      if (!result.valid) {
        return { error: { message: "connectorConfig is invalid", errors: result.errors, warnings: result.warnings } };
      }
      out.connectorConfig = result.normalized;
      out.__warnings = result.warnings;
    }
  } else if (current && has("protocol") && current.connectorConfig && protocol !== current.protocol) {
    // Protocol changed but the old config was written for another protocol.
    const result = validateConnectorConfig(protocol, current.connectorConfig);
    if (!result.valid) {
      return { error: { message: `Existing connectorConfig is not valid for protocol ${protocol}; send a new connectorConfig`, errors: result.errors } };
    }
  }
  return { values: out };
}

// GET /api/erp-configs/connector-schema — vocabulary for the config UI.
const getConnectorSchema = (req, res) => {
  const { protocol } = req.query;
  const data = describeSchema();
  if (protocol) {
    if (!PROTOCOLS.includes(protocol)) {
      return res.status(400).json({ success: false, message: `protocol must be one of: ${PROTOCOLS.join(", ")}` });
    }
    data.starterConfig = defaultConnectorConfig(protocol);
  }
  return res.json({ success: true, data });
};

// POST /api/erp-configs/validate-connector — dry-run validation (no save).
const validateConnector = (req, res) => {
  const { protocol, connectorConfig } = req.body || {};
  const result = validateConnectorConfig(protocol, connectorConfig);
  return res.json({
    success: true,
    data: {
      valid: result.valid,
      errors: result.errors,
      warnings: result.warnings,
      capabilities: result.valid ? computeCapabilities(result.normalized) : null,
    },
  });
};

// Fields we never want written into audit oldValue/newValue snapshots
// (credentials) — audit trail should show that config changed, not leak secrets.
const SENSITIVE_ERP_FIELDS = ["password", "apiKey", "inboundPassword"];
function sanitizeErpConfig(erp) {
  if (!erp) return erp;
  const plain = typeof erp.toJSON === "function" ? erp.toJSON() : { ...erp };
  const hasPassword = Boolean(plain.password);
  const hasApiKey = Boolean(plain.apiKey);
  const hasInboundPassword = Boolean(plain.inboundPassword);
  delete plain.password;
  delete plain.apiKey;
  delete plain.inboundPassword;
  plain.passwordConfigured = hasPassword;
  plain.apiKeyConfigured = hasApiKey;
  plain.inboundPasswordConfigured = hasInboundPassword;
  return plain;
}

// POST /api/erp-configs
const createErpConfig = async (req, res) => {
  try {
    const { ErpConfig } = req.masterModels;
    const {
      name,
      erpType,
      baseUrl,
      integrationMode,
      username,
      password,
      authType,
      apiKey,
      // ── Dynamic multi-tenant SAP mapping (all optional) ──────────
      // Left empty, a new tenant gets exactly today's Golyan defaults —
      // see services/sapEntityResolver.js.
      metadataUrl,
      odataVersion,
      entitySetMap,
      fieldMap,
      functionMap,
      inboundUsername,
      inboundPassword,
    } = req.body;

    const mode = integrationMode || "BOTH";
    if (!name || !erpType || !["INBOUND", "OUTBOUND", "BOTH"].includes(mode)) {
      return res.status(400).json({ success: false, message: "name, erpType and a valid integrationMode are required" });
    }

    // DYNAMIC ERP CONNECTOR (Step 1): erpType is free text now; protocol /
    // connectorConfig / templateKey are validated before anything is saved.
    const connector = resolveConnectorFields(req.body, null);
    if (connector.error) {
      return res.status(400).json({ success: false, ...connector.error });
    }
    const { __warnings: connectorWarnings, ...connectorValues } = connector.values;
    if (["OUTBOUND", "BOTH"].includes(mode) && !baseUrl) {
      return res.status(400).json({
        success: false,
        message: "baseUrl is required for outbound integration",
      });
    }

    // Inbound-only SAP → Evault configurations do not call an ERP endpoint,
    // so baseUrl is intentionally not required and is stored as NULL.
    const normalizedBaseUrl = ["INBOUND"].includes(mode) ? null : (baseUrl || null);

    const exists = await ErpConfig.findOne({ where: { name } });

    if (exists) {
      return res.status(409).json({
        success: false,
        message: "ERP configuration already exists",
      });
    }

    const erp = await ErpConfig.create({
      name,
      ...connectorValues,
      baseUrl: normalizedBaseUrl,
      integrationMode: mode,
      username,
      password: encryptSecret(password),
      authType,
      apiKey: encryptSecret(apiKey),
      metadataUrl,
      odataVersion,
      entitySetMap,
      fieldMap,
      functionMap,
      inboundUsername: inboundUsername || null,
      inboundPassword: inboundPassword ? encryptSecret(inboundPassword) : null,
      status: "ACTIVE",
    });

    // ── Audit: ERP config created ───────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.ERP_CONFIG,
      action: AUDIT_ACTIONS.ERP_CONFIG_CREATED,
      newValue: sanitizeErpConfig(erp),
      remarks: `Created ERP configuration "${erp.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({
      success: true,
      data: sanitizeErpConfig(erp),
      ...(connectorWarnings && connectorWarnings.length ? { warnings: connectorWarnings } : {}),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
}; 

const testConnection = async (req, res) => {
  const { ErpConfig } = req.masterModels;
  try {
    const { id } = req.params;

    const erp = await ErpConfig.findByPk(id);

    if (!erp) {
      return res.status(404).json({
        success: false,
        message: "ERP configuration not found",
      });
    }
    if (erp.integrationMode === "INBOUND") {
      return res.status(400).json({ success: false, message: "Outbound connection test is not available for an inbound-only configuration" });
    }

    // MULTI-ERP FIX: this always called SapService.testConnection() here,
    // regardless of erpType — so testing an Oracle or Custom connection ran
    // SAP's CSRF/OData probe against a non-SAP endpoint and failed (or, for
    // ERPs the switch didn't even know about, threw before getting this
    // far). Route through ErpFactory like every other ERP-facing call.
    const erpService = ErpFactory.getService(erp);
    await erpService.testConnection(erp, (msg) => {
      console.log(msg);
    });
    await erp.update({
      status: "CONNECTED",
    });

    return res.json({
      success: true,
      message: "Connection successful",
    });

  } catch (err) {

    if (req.params.id) {
      await ErpConfig.update(
        { status: "FAILED" },
        { where: { id: req.params.id } }
      );
    }

    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }
};

// GET /api/erp-configs
const listErpConfigs = async (req, res) => {
  try {
    const { ErpConfig } = req.masterModels;
    const data = await ErpConfig.findAll({
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      success: true,
      count: data.length,
      data: data.map(sanitizeErpConfig),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// GET /api/erp-configs/:id
const getErpConfig = async (req, res) => {
  try {
    const { ErpConfig } = req.masterModels;
    const erp = await ErpConfig.findByPk(req.params.id);

    if (!erp) {
      return res.status(404).json({
        success: false,
        message: "ERP configuration not found",
      });
    }

    return res.json({
      success: true,
      data: sanitizeErpConfig(erp),
      ...(connectorWarnings && connectorWarnings.length ? { warnings: connectorWarnings } : {}),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// PUT /api/erp-configs/:id
const updateErpConfig = async (req, res) => {
  try {
    const { ErpConfig } = req.masterModels;
    const erp = await ErpConfig.findByPk(req.params.id);

    if (!erp) {
      return res.status(404).json({
        success: false,
        message: "ERP configuration not found",
      });
    }

    const oldValue = sanitizeErpConfig(erp);

    const allowedFields = [
      "name", "sapClient", "description", "status", "isDefault",
      "baseUrl", "integrationMode", "username", "authType", "inboundUsername", "metadataUrl", "odataVersion",
      "entitySetMap", "fieldMap", "functionMap",
    ];
    const updateData = {};
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updateData[field] = req.body[field];
      }
    }

    // DYNAMIC ERP CONNECTOR (Step 1): erpType / protocol / connectorConfig /
    // templateKey go through the shared validator instead of the raw copy.
    const connector = resolveConnectorFields(req.body, erp);
    if (connector.error) {
      return res.status(400).json({ success: false, ...connector.error });
    }
    const { __warnings: connectorWarnings, ...connectorValues } = connector.values;
    Object.assign(updateData, connectorValues);
    if (updateData.authType !== undefined && updateData.authType !== null && !AUTH_TYPES.includes(updateData.authType)) {
      return res.status(400).json({ success: false, message: `authType must be one of: ${AUTH_TYPES.join(", ")}` });
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "inboundPassword")) {
      updateData.inboundPassword = req.body.inboundPassword ? encryptSecret(req.body.inboundPassword) : null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "password")) {
      updateData.password = encryptSecret(req.body.password);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "apiKey")) {
      updateData.apiKey = encryptSecret(req.body.apiKey);
    }

    // Validate the effective integration direction before persisting.
    const effectiveMode = updateData.integrationMode || erp.integrationMode || "BOTH";
    if (!["INBOUND", "OUTBOUND", "BOTH"].includes(effectiveMode)) {
      return res.status(400).json({
        success: false,
        message: "integrationMode must be INBOUND, OUTBOUND or BOTH",
      });
    }
    if (["OUTBOUND", "BOTH"].includes(effectiveMode) &&
        Object.prototype.hasOwnProperty.call(updateData, "baseUrl") &&
        !updateData.baseUrl) {
      return res.status(400).json({
        success: false,
        message: "baseUrl is required for outbound integration",
      });
    }
    if (effectiveMode === "INBOUND" &&
        !Object.prototype.hasOwnProperty.call(updateData, "baseUrl")) {
      updateData.baseUrl = null;
    }

    if (updateData.username) {
      const duplicate = await ErpConfig.findOne({
        where: { username: updateData.username },
      });
      if (duplicate && duplicate.id !== erp.id) {
        return res.status(409).json({
          success: false,
          message: "ERP username is already assigned to another ERP configuration",
        });
      }
    }

    await erp.update(updateData);

    // ── Audit: ERP config updated ───────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.ERP_CONFIG,
      action: AUDIT_ACTIONS.ERP_CONFIG_UPDATED,
      oldValue,
      newValue: sanitizeErpConfig(erp),
      remarks: `Updated ERP configuration "${erp.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({
      success: true,
      data: sanitizeErpConfig(erp),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// POST /api/erp-configs/:id/inbound-credentials
// Generates a dedicated SAP -> Evault Basic Auth credential. The secret is
// returned once; only its encrypted form is retained in the Master DB.
const generateInboundCredentials = async (req, res) => {
  try {
    const { ErpConfig } = req.masterModels;
    const erp = await ErpConfig.findByPk(req.params.id);
    if (!erp) return res.status(404).json({ success: false, message: "ERP configuration not found" });
    // if (erp.erpType !== "SAP") return res.status(400).json({ success: false, message: "Inbound credentials are currently supported for SAP only" });

    const crypto = require("crypto");
    const username = `evault_${crypto.randomBytes(8).toString("hex")}`;
    const password = crypto.randomBytes(24).toString("base64url");
    await erp.update({ inboundUsername: username, inboundPassword: encryptSecret(password), integrationMode: erp.integrationMode === "OUTBOUND" ? "BOTH" : (erp.integrationMode || "INBOUND") });

    return res.status(201).json({
      success: true,
      message: "Inbound SAP → Evault credentials generated. Store the password securely; it will not be shown again.",
      data: { username, password, authType: "BASIC", endpoint: "/api/v1/vault/documents/upload" },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/erp-configs/:id
const deleteErpConfig = async (req, res) => {
  try {
    const { ErpConfig } = req.masterModels;
    const erp = await ErpConfig.findByPk(req.params.id);

    if (!erp) {
      return res.status(404).json({
        success: false,
        message: "ERP configuration not found",
      });
    }

    await erp.update({
      status: "INACTIVE",
    });

    // ── Audit: ERP config deactivated ───────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.ERP_CONFIG,
      action: AUDIT_ACTIONS.ERP_CONFIG_DELETED,
      oldValue: { status: "ACTIVE" },
      newValue: { status: "INACTIVE" },
      remarks: `Deactivated ERP configuration "${erp.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({
      success: true,
      message: "ERP configuration deactivated successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const testConnectionStream = async (req, res) => {
  const { ErpConfig } = req.masterModels;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (msg) => {
    res.write(`data: ${msg}\n\n`);
  };

  try {
    const erp = await ErpConfig.findByPk(req.params.id);

    if (!erp) {
      send("❌ ERP configuration not found");
      return res.end();
    }

    // MULTI-ERP FIX: same hardcoded-SAP bug as testConnection() above.
    const erpService = ErpFactory.getService(erp);
    await erpService.testConnection(erp, send);

    await erp.update({
      status: "CONNECTED",
      lastTestedAt: new Date(),
    });

    send("🎉 Connection completed");
    res.end();
  } catch (err) {
    await ErpConfig.update(
      { status: "FAILED" },
      { where: { id: req.params.id } }
    );

    send(`❌ ${err.message}`);
    res.end();
  }
};

// GET /api/erp-configs/:id/metadata
// STEP 7 — Metadata Discovery: reads $metadata dynamically and returns the
// EntitySets / EntityTypes / FunctionImports this tenant's SAP Gateway
// actually exposes. Also caches the snapshot on the ErpConfig row so the
// mapping-configuration UI can render dropdowns without re-fetching.
const discoverMetadata = async (req, res) => {
  try {
    const { ErpConfig } = req.masterModels;
    const erp = await ErpConfig.findByPk(req.params.id);
    if (!erp) {
      return res.status(404).json({ success: false, message: "ERP configuration not found" });
    }

    const metadata = await SapMetadataService.discoverMetadata(erp);

    await erp.update({
      metadataSnapshot: metadata,
      metadataFetchedAt: new Date(),
    });

    return res.json({ success: true, data: metadata });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/erp-configs/:id/validate
// STEP 8 — Validation Layer: checks the tenant's configured (or defaulted)
// EntitySet / FunctionImport mapping against real $metadata and returns a
// clear list of problems, instead of a runtime crash during sync.
const validateMapping = async (req, res) => {
  try {
    const { ErpConfig } = req.masterModels;
    const erp = await ErpConfig.findByPk(req.params.id);
    if (!erp) {
      return res.status(404).json({ success: false, message: "ERP configuration not found" });
    }

    const result = await SapMetadataService.validateTenantMapping(erp);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  createErpConfig,
  generateInboundCredentials,
  listErpConfigs,
  getErpConfig,
  updateErpConfig,
  deleteErpConfig,
  testConnection,
  testConnectionStream,
  discoverMetadata,
  validateMapping,
  getConnectorSchema,
  validateConnector,
};