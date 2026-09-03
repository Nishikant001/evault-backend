// src/services/masterDataService.js
//
// Generic master-data reader used by /api/master-data (departments,
// categories). Previously hardcoded to ONE global SAP connection read
// from env vars (config/sapConfig.js) — every tenant shared the same SAP
// system, which is exactly the single-customer assumption this refactor
// removes. Now takes the caller's resolved ErpConfig (per tenant, per
// services/erpService.js) and the already-resolved EntitySet name (see
// services/sapEntityResolver.js), so it works for ANY tenant's SAP
// Gateway without a code change.
//
// Response shape is intentionally unchanged (raw OData response body) —
// only the origin of the connection details and the EntitySet name are
// now dynamic, so the existing frontend contract for this endpoint keeps
// working as-is.
const ErpService = require("./erpService");

class MasterDataService {
  static async getData(erpConfig, entitySetName) {
    const client = ErpService.createClient(erpConfig, {
      Accept: "application/json",
    });

    const params = erpConfig.sapClient ? { "sap-client": erpConfig.sapClient } : {};

    const response = await client.get(`/${entitySetName}`, { params });

    return response.data;
  }
}

module.exports = MasterDataService;
