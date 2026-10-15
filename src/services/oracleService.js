// src/services/oracleService.js
//
// Oracle / Oracle Fusion support.
//
// This file used to be empty — an ErpConfig with erpType "ORACLE" would
// resolve through ErpFactory to a service with no methods, and every call
// (test connection, sync, document fetch) would throw "X is not a
// function". That is the "Oracle is just a dropdown label" problem
// described in the brief.
//
// Oracle Fusion Cloud's integration surface (ERP REST APIs, and OData for
// several modules) fits the REST/ODATA protocols the generic Connector
// Engine already executes, so Oracle needs no bespoke adapter — this file
// exists mainly so `erpType: "ORACLE"` reads clearly in code and logs, and
// as the one place to add anything genuinely Oracle-specific later (e.g. a
// quirk in how Oracle Fusion paginates or authenticates that a future
// tenant's real endpoint turns out to need). Today it is a pure delegate.
"use strict";

const GenericErpService = require("./genericErpService");

class OracleService {
  static testConnection(erpConfig, progress) {
    return GenericErpService.testConnection(erpConfig, progress);
  }

  static getDocumentById(erpConfig, externalId) {
    return GenericErpService.getDocumentById(erpConfig, externalId);
  }

  static getDocumentBinary(erpConfig, externalId) {
    return GenericErpService.getDocumentBinary(erpConfig, externalId);
  }

  static uploadDocumentToSap(erpConfig, fileBuffer, mimeType, fileName, docMeta) {
    return GenericErpService.uploadDocumentToSap(erpConfig, fileBuffer, mimeType, fileName, docMeta);
  }
}

module.exports = OracleService;
