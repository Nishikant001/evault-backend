"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // ── Relax hierarchy/uploader FKs to nullable ────────────────
    // Safe for the existing local-upload flow (documentController.uploadDocument
    // always supplies these), and required so SAP Document Synchronization can
    // store a document whose classification codes don't resolve yet.
    await queryInterface.changeColumn("documents", "departmentId", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: "departments", key: "id" },
    });
    await queryInterface.changeColumn("documents", "categoryId", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: "categories", key: "id" },
    });
    await queryInterface.changeColumn("documents", "documentTypeId", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: "document_types", key: "id" },
    });
    await queryInterface.changeColumn("documents", "uploadedBy", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    });
    await queryInterface.changeColumn("documents", "mimeType", {
      type: Sequelize.STRING,
      allowNull: true,
    });

    // ── sapDocumentId becomes the idempotency key ───────────────
    await queryInterface.changeColumn("documents", "sapDocumentId", {
      type: Sequelize.STRING,
      allowNull: true,
      unique: true,
    });

    // ── New SAP Document Synchronization columns ────────────────
    await queryInterface.addColumn("documents", "sourceType", {
      type: Sequelize.ENUM("LOCAL_UPLOAD", "SAP_SYNC"),
      allowNull: false,
      defaultValue: "LOCAL_UPLOAD",
      after: "sapPhioId",
    });
    await queryInterface.addColumn("documents", "sapSyncStatus", {
      type: Sequelize.ENUM("SYNCED", "PENDING_CLASSIFICATION", "FAILED"),
      allowNull: true,
      after: "sourceType",
    });
    await queryInterface.addColumn("documents", "sapRawDepartmentCode", {
      type: Sequelize.STRING,
      allowNull: true,
      after: "sapSyncStatus",
    });
    await queryInterface.addColumn("documents", "sapRawCategoryCode", {
      type: Sequelize.STRING,
      allowNull: true,
      after: "sapRawDepartmentCode",
    });
    await queryInterface.addColumn("documents", "sapRawDocumentTypeCode", {
      type: Sequelize.STRING,
      allowNull: true,
      after: "sapRawCategoryCode",
    });
    await queryInterface.addColumn("documents", "sapMetaSyncedAt", {
      type: Sequelize.DATE,
      allowNull: true,
      after: "sapRawDocumentTypeCode",
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn("documents", "sapMetaSyncedAt");
    await queryInterface.removeColumn("documents", "sapRawDocumentTypeCode");
    await queryInterface.removeColumn("documents", "sapRawCategoryCode");
    await queryInterface.removeColumn("documents", "sapRawDepartmentCode");
    await queryInterface.removeColumn("documents", "sapSyncStatus");
    await queryInterface.removeColumn("documents", "sourceType");

    await queryInterface.changeColumn("documents", "sapDocumentId", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.changeColumn("documents", "mimeType", {
      type: Sequelize.STRING,
      allowNull: false,
    });
    await queryInterface.changeColumn("documents", "uploadedBy", {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
    });
    await queryInterface.changeColumn("documents", "documentTypeId", {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: "document_types", key: "id" },
    });
    await queryInterface.changeColumn("documents", "categoryId", {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: "categories", key: "id" },
    });
    await queryInterface.changeColumn("documents", "departmentId", {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: "departments", key: "id" },
    });
  },
};
