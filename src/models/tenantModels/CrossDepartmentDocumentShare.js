"use strict";

const { DataTypes } = require("sequelize");

module.exports = (sequelize) =>
  sequelize.define(
    "CrossDepartmentDocumentShare",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },

      // ======================================================
      // TENANT
      // ======================================================

      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      // ======================================================
      // REQUEST
      // ======================================================

      requestId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      // ======================================================
      // RECIPIENT
      // ======================================================

      recipientUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,

        references: {
          model: "users",
          key: "id",
        },
      },

      // ======================================================
      // SOURCE DOCUMENT
      // ======================================================
      //
      // This is ONLY a reference to the existing DMS document.
      // Never modify the original document.
      //

      sourceDocumentId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      sourceDocumentVersion: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      // ======================================================
      // TEMPORARY ARTIFACT
      // ======================================================
      //
      // The actual temporary/masked file must be stored through
      // the existing storage mechanism, not inside this table.
      //

      temporaryStorageKey: {
        type: DataTypes.STRING(1000),
        allowNull: true,
      },

      temporaryFileName: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },

      temporaryMimeType: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      // ======================================================
      // MASKING
      // ======================================================

      maskingRequired: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },

      maskingData: {
        type: DataTypes.JSON,
        allowNull: true,
      },

      maskedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      maskedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,

        references: {
          model: "users",
          key: "id",
        },
      },

      // ======================================================
      // ACCESS
      // ======================================================

      status: {
        type: DataTypes.ENUM(
          "PREPARED",
          "ACTIVE",
          "REVOKED",
          "EXPIRED"
        ),

        allowNull: false,

        defaultValue: "PREPARED",
      },

      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },

      sentAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      sentBy: {
        type: DataTypes.INTEGER,
        allowNull: true,

        references: {
          model: "users",
          key: "id",
        },
      },

      // ======================================================
      // REVOKE
      // ======================================================

      revokedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      revokedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,

        references: {
          model: "users",
          key: "id",
        },
      },

      revokeReason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      // ======================================================
      // CLEANUP
      // ======================================================

      cleanedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },

    {
      tableName: "cross_department_document_shares",

      timestamps: true,

      indexes: [
        {
          fields: [
            "tenantId",
            "recipientUserId",
          ],
        },

        {
          fields: [
            "tenantId",
            "requestId",
          ],
        },

        {
          fields: [
            "tenantId",
            "sourceDocumentId",
          ],
        },

        {
          fields: [
            "tenantId",
            "status",
          ],
        },

        {
          fields: [
            "expiresAt",
          ],
        },
      ],
    }
  );