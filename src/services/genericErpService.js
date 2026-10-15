// src/services/genericErpService.js
//
// The non-SAP counterpart to sapService.js. ErpFactory routes every
// erpType OTHER than "SAP" here — Oracle, Custom, Dynamics, Odoo,
// NetSuite, the 50th ERP nobody's added yet — so none of them need their
// own hand-written service file. Everything is driven by the ERP's own
// connectorConfig (see services/connector/connectorSchema.js) through the
// generic Connector Engine (services/connector/connectorEngine.js).
//
// Method shape mirrors SapService exactly (same 4 methods called
// polymorphically via ErpFactory.getService() across documentController.js,
// sapFinalizationService.js, crossDepartmentDocumentService.js and
// sapSyncExtController.js) so no caller needs an erpType branch.
"use strict";

const ConnectorEngine = require("./connector/connectorEngine");

function assertConfigured(erpConfig) {
  if (!["REST", "ODATA"].includes(erpConfig.protocol)) {
    throw new Error(
      `${erpConfig.erpType} connection "${erpConfig.name}" uses protocol ${erpConfig.protocol}, which the generic connector engine cannot execute yet (only REST and ODATA are wired up). ` +
      `Configuring is fully supported; live calls are not, for this protocol.`,
    );
  }
  if (!erpConfig.connectorConfig) {
    throw new Error(`${erpConfig.erpType} connection "${erpConfig.name}" has no connectorConfig — configure its entities before using it.`);
  }
}

class GenericErpService {
  static async testConnection(erpConfig, progress = () => {}) {
    assertConfigured(erpConfig);
    return ConnectorEngine.testConnection(erpConfig, progress);
  }

  /** Metadata for one document by its external id (mirrors SapService.getDocumentById). */
  static async getDocumentById(erpConfig, externalId) {
    assertConfigured(erpConfig);
    const entities = erpConfig.connectorConfig.entities || {};
    if (!entities.DOCUMENT?.enabled) {
      throw new Error(`${erpConfig.erpType} connection "${erpConfig.name}" does not have the DOCUMENT entity configured — cannot look up document metadata.`);
    }
    const { records } = await ConnectorEngine.syncEntity(erpConfig, "DOCUMENT");
    const match = records.find((r) => String(r.mapped?.externalId) === String(externalId));
    if (!match) throw new Error(`Document ${externalId} was not found via ${erpConfig.erpType}`);
    if (match.errors.length) throw new Error(`Document ${externalId} failed validation: ${match.errors.join("; ")}`);
    return match.mapped;
  }

  /** File bytes for one document (mirrors SapService.getDocumentBinary). */
  static async getDocumentBinary(erpConfig, externalId) {
    assertConfigured(erpConfig);
    const entities = erpConfig.connectorConfig.entities || {};
    const contentCfg = entities.DOCUMENT_CONTENT;
    if (!contentCfg?.enabled) {
      throw new Error(`${erpConfig.erpType} connection "${erpConfig.name}" does not have DOCUMENT_CONTENT configured — content download is not available for this ERP.`);
    }
    // DOCUMENT_CONTENT is sourceOnly (no mapping) — its `source.path` is a
    // template resolved against the externalId, e.g. "/documents/{externalId}/content".
    const source = {
      ...contentCfg.source,
      path: (contentCfg.source.path || "").replace("{externalId}", encodeURIComponent(externalId)),
    };
    // The engine's fetchRaw() always parses JSON, so binary content download
    // (arraybuffer) is built directly here, reusing the same auth rules.
    const axios = require("axios");
    const { decryptSecret } = require("./erpCredentialService");
    const cfg = erpConfig.connectorConfig;
    const conn = cfg.connection || {};
    const client = axios.create({ baseURL: erpConfig.baseUrl, timeout: conn.timeoutMs || 60000 });

    const headers = {};
    const auth = cfg.auth || { type: "NONE" };
    if (auth.type === "BASIC") {
      headers.Authorization = `Basic ${Buffer.from(`${erpConfig.username || ""}:${decryptSecret(erpConfig.password) || ""}`).toString("base64")}`;
    } else if (auth.type === "BEARER") {
      headers[auth.headerName || "Authorization"] = `Bearer ${decryptSecret(erpConfig.apiKey)}`;
    } else if (auth.type === "API_KEY" && auth.in !== "query") {
      headers[auth.name || "x-api-key"] = decryptSecret(erpConfig.apiKey);
    }

    const resp = await client.get(source.path, { headers, responseType: "arraybuffer", validateStatus: () => true });
    if (resp.status >= 400) {
      throw new Error(`${erpConfig.erpType} returned ${resp.status} fetching content for ${externalId}`);
    }
    return { buffer: Buffer.from(resp.data), contentType: resp.headers["content-type"] || "application/octet-stream" };
  }

  /**
   * Outbound Evault -> ERP document push (mirrors SapService.uploadDocumentToSap).
   * There is no generic "how do I push a file out" schema yet — SAP's
   * upload path is CSRF-token + batch-OData specific and isn't something
   * a REST/OData JSON description can represent without real endpoint
   * samples. Rather than invent one, this fails clearly. Inbound sync
   * (ERP -> Evault, via the DOCUMENT / DOCUMENT_CONTENT entities above)
   * is the fully working generic path.
   */
  static async uploadDocumentToSap(erpConfig /*, fileBuffer, mimeType, fileName, docMeta */) {
    throw new Error(
      `Outbound document upload (Evault -> ${erpConfig.erpType}) is not implemented for generic (non-SAP) ERP connections yet. ` +
      `Inbound sync (${erpConfig.erpType} -> Evault, via the DOCUMENT and DOCUMENT_CONTENT entities) is fully supported — see the connector configuration for "${erpConfig.name}".`,
    );
  }
}

module.exports = GenericErpService;
