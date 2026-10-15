// src/services/erpFactory.js
//
// MULTI-ERP FIX: this used to switch on erpType with a fixed SAP/ORACLE
// list and throw "Unsupported ERP Type" for anything else — so assigning
// a tenant a "CUSTOM" or "DYNAMICS" or "ODOO" connection (all valid,
// already-supported erpType values per connectorSchema.normalizeErpType)
// would crash the moment any code tried to actually use it. Adding the
// 50th ERP should mean filling in a connectorConfig, not editing this file.
//
// SAP keeps its own dedicated, battle-tested service (CSRF/batch-OData
// upload flow, entity resolver, etc — see SAP_MULTITENANT_REFACTOR_REPORT.md).
// Every other erpType — ORACLE, CUSTOM, or anything not yet invented —
// resolves to the generic, connectorConfig-driven service, so the engine
// genuinely never needs a new adapter file to onboard another ERP.
const SapService = require("./sapService");
const GenericErpService = require("./genericErpService");

class ErpFactory {
  static getService(erpConfig) {
    if (!erpConfig || !erpConfig.erpType) {
      throw new Error("ErpFactory.getService: erpConfig with an erpType is required");
    }
    if (erpConfig.erpType === "SAP") {
      return SapService;
    }
    // ORACLE, CUSTOM, DYNAMICS, ODOO, NETSUITE, ... — anything else.
    return GenericErpService;
  }
}

module.exports = ErpFactory;
