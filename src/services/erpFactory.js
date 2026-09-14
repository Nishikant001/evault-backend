const SapService = require("./sapService");
const OracleService = require("./oracleService");

class ErpFactory {
  static getService(erpConfig) {
    switch (erpConfig.erpType) {
      case "SAP":
        return SapService;

      case "ORACLE":
        return OracleService;

      default:
        throw new Error(
          `Unsupported ERP Type: ${erpConfig.erpType}`
        );
    }
  }
}

module.exports = ErpFactory;