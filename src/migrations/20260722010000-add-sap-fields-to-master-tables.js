"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // ── departments ──────────────────────────────────────────
    await queryInterface.addColumn("departments", "sapCode", {
      type: Sequelize.STRING,
      allowNull: true,
      unique: true,
      after: "status",
    });
    await queryInterface.addColumn("departments", "lastSyncedAt", {
      type: Sequelize.DATE,
      allowNull: true,
      after: "sapCode",
    });

    // ── categories ───────────────────────────────────────────
    await queryInterface.addColumn("categories", "sapCode", {
      type: Sequelize.STRING,
      allowNull: true,
      after: "status",
    });
    await queryInterface.addColumn("categories", "lastSyncedAt", {
      type: Sequelize.DATE,
      allowNull: true,
      after: "sapCode",
    });
    await queryInterface.addIndex("categories", ["tenantId", "sapCode"], {
      unique: true,
      name: "unique_category_sapcode_per_tenant",
    });

    // ── document_types ───────────────────────────────────────
    await queryInterface.addColumn("document_types", "sapCode", {
      type: Sequelize.STRING,
      allowNull: true,
      after: "status",
    });
    await queryInterface.addColumn("document_types", "lastSyncedAt", {
      type: Sequelize.DATE,
      allowNull: true,
      after: "sapCode",
    });
    await queryInterface.addIndex("document_types", ["tenantId", "sapCode"], {
      unique: true,
      name: "unique_doctype_sapcode_per_tenant",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex("document_types", "unique_doctype_sapcode_per_tenant");
    await queryInterface.removeColumn("document_types", "lastSyncedAt");
    await queryInterface.removeColumn("document_types", "sapCode");

    await queryInterface.removeIndex("categories", "unique_category_sapcode_per_tenant");
    await queryInterface.removeColumn("categories", "lastSyncedAt");
    await queryInterface.removeColumn("categories", "sapCode");

    await queryInterface.removeColumn("departments", "lastSyncedAt");
    await queryInterface.removeColumn("departments", "sapCode");
  },
};
