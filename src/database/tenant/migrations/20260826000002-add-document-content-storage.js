// src/database/tenant/migrations/20260826000002-add-document-content-storage.js

"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("document_contents").catch(
      () => null
    );

    if (!table) {
      await queryInterface.createTable("document_contents", {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },

        documentId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          unique: true,
          references: {
            model: "documents",
            key: "id",
          },
          onDelete: "CASCADE",
          onUpdate: "CASCADE",
        },

        content: {
          type: Sequelize.BLOB("long"),
          allowNull: false,
        },

        contentLength: {
          type: Sequelize.BIGINT,
          allowNull: false,
        },

        checksumSha256: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },

        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },

        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
      });
    }

    // Add SAP_CONTENT_API to the existing sourceType ENUM.
    await queryInterface.changeColumn("documents", "sourceType", {
      type: Sequelize.ENUM(
        "LOCAL_UPLOAD",
        "SAP_SYNC",
        "SAP_CONTENT_API"
      ),
      allowNull: false,
      defaultValue: "LOCAL_UPLOAD",
    });
  },

  async down(queryInterface, Sequelize) {
    // Do not automatically delete document binary data during rollback.
    // This migration is intentionally non-destructive.
  },
};