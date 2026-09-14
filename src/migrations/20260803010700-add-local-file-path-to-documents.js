"use strict";

// Nullable, additive column. Only ever populated for FREE-tenant documents
// (see localFinalizationService.js) — PAID documents continue to store
// their binary in SAP exactly as today and never populate this column.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("documents", "localFilePath", {
      type: Sequelize.STRING,
      allowNull: true,
      comment:
        "Permanent local storage path for FREE-tenant documents (never uploaded to SAP). Null for PAID/SAP-backed documents.",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("documents", "localFilePath");
  },
};
