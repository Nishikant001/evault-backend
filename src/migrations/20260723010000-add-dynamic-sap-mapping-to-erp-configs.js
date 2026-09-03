"use strict";

// ── Multi-tenant SAP integration: dynamic mapping columns ──────────────
// Adds the configuration surface that lets every SAP customer (tenant)
// expose completely different EntitySet names, field/property names, and
// FunctionImport names WITHOUT any backend code changes — see
// src/services/sapEntityResolver.js and src/services/sapMetadataService.js.
//
// All columns are nullable with no default mapping data. When they are
// null/empty for a given ErpConfig row, every consumer falls back to the
// existing hardcoded constants in constants/sapSyncConstants.js — this is
// exactly today's Golyan behavior, so nothing changes for the current
// tenant unless/until someone fills in an override.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("erp_configs", "metadataUrl", {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: "Optional override for the OData $metadata document URL, if it differs from baseUrl + '/$metadata'.",
    });

    await queryInterface.addColumn("erp_configs", "odataVersion", {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: "v2",
      comment: "OData protocol version this tenant's SAP Gateway speaks (v2 today; forward-compatible slot for v4).",
    });

    await queryInterface.addColumn("erp_configs", "entitySetMap", {
      type: Sequelize.JSON,
      allowNull: true,
      comment:
        "Logical -> actual EntitySet name overrides, e.g. { \"DEPARTMENT\": \"DepartmentMaster\", \"CATEGORY\": \"Categories\", \"DOCUMENT_TYPE\": \"DocTypes\", \"DOCUMENT\": \"Documents\" }. Falls back to SAP_SYNC_ENTITY_SETS when absent.",
    });

    await queryInterface.addColumn("erp_configs", "fieldMap", {
      type: Sequelize.JSON,
      allowNull: true,
      comment:
        "Per-entity logical -> actual property name overrides, e.g. { \"DEPARTMENT\": { \"code\": \"DivisionCode\", \"name\": \"DivisionName\" }, ... }. Tried before the legacy FIELD_CANDIDATES probe list.",
    });

    await queryInterface.addColumn("erp_configs", "functionMap", {
      type: Sequelize.JSON,
      allowNull: true,
      comment:
        "FunctionImport name overrides, e.g. { \"upload\": \"UploadDocument\", \"confirm\": \"FinalizeUpload\", \"uploadXstring\": \"UploadDocumentXstring\", \"responseFields\": { \"documentId\": \"DocumentId\", \"uploadUrl\": \"UploadUrl\", \"phioId\": \"PhioId\" } }.",
    });

    await queryInterface.addColumn("erp_configs", "metadataSnapshot", {
      type: Sequelize.JSON,
      allowNull: true,
      comment: "Last successful $metadata discovery result (EntitySets/EntityTypes/Properties/FunctionImports), cached for the validation UI.",
    });

    await queryInterface.addColumn("erp_configs", "metadataFetchedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("erp_configs", "metadataFetchedAt");
    await queryInterface.removeColumn("erp_configs", "metadataSnapshot");
    await queryInterface.removeColumn("erp_configs", "functionMap");
    await queryInterface.removeColumn("erp_configs", "fieldMap");
    await queryInterface.removeColumn("erp_configs", "entitySetMap");
    await queryInterface.removeColumn("erp_configs", "odataVersion");
    await queryInterface.removeColumn("erp_configs", "metadataUrl");
  },
};
