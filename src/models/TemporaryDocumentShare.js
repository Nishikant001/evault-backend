// src/models/TemporaryDocumentShare.js

"use strict";

module.exports = (sequelize, DataTypes) => {
  const TemporaryDocumentShare =
    sequelize.define(
      "TemporaryDocumentShare",
      {
        id: {
          type: DataTypes.BIGINT.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },

        tenantId: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: false,
          field: "tenant_id",
        },

        requestId: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: false,
          field: "request_id",
        },

        sourceDocumentId: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: false,
          field: "source_document_id",
        },

        sourceDocumentVersion: {
          type: DataTypes.STRING(100),
          allowNull: true,
          field: "source_document_version",
        },

        createdBy: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: false,
          field: "created_by",
        },

        durationMinutes: {
          type: DataTypes.INTEGER.UNSIGNED,
          allowNull: false,
          defaultValue: 60,
          field: "duration_minutes",
        },

        maskingRequired: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
          field: "masking_required",
        },

        masks: {
          type: DataTypes.JSON,
          allowNull: true,
        },

        maskedAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: "masked_at",
        },

        maskedBy: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: true,
          field: "masked_by",
        },

        expiresAt: {
          type: DataTypes.DATE,
          allowNull: false,
          field: "expires_at",
        },

        status: {
          type: DataTypes.ENUM(
            "PREPARED",
            "MASKED",
            "SENT",
            "REVOKED",
            "EXPIRED"
          ),
          allowNull: false,
          defaultValue: "PREPARED",
        },

        sentAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: "sent_at",
        },

        sentBy: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: true,
          field: "sent_by",
        },

        revokedAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: "revoked_at",
        },

        revokedBy: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: true,
          field: "revoked_by",
        },

        revokeReason: {
          type: DataTypes.TEXT,
          allowNull: true,
          field: "revoke_reason",
        },
      },
      {
        tableName:
          "temporary_document_shares",

        timestamps: true,

        underscored: true,

        indexes: [
          {
            name:
              "idx_tdshare_tenant_status",
            fields: [
              "tenant_id",
              "status",
            ],
          },

          {
            name:
              "idx_tdshare_request",
            fields: [
              "tenant_id",
              "request_id",
            ],
          },

          {
            name:
              "idx_tdshare_document",
            fields: [
              "tenant_id",
              "source_document_id",
            ],
          },

          {
            name:
              "idx_tdshare_expiry",
            fields: [
              "expires_at",
            ],
          },
        ],
      }
    );


  // ==========================================================
  // ASSOCIATIONS
  // ==========================================================

  TemporaryDocumentShare.associate =
    (models) => {

      if (
        models.CrossDepartmentDocumentRequest
      ) {
        TemporaryDocumentShare.belongsTo(
          models.CrossDepartmentDocumentRequest,
          {
            foreignKey:
              "requestId",

            as: "request",
          }
        );
      }

      if (models.Document) {
        TemporaryDocumentShare.belongsTo(
          models.Document,
          {
            foreignKey:
              "sourceDocumentId",

            as: "sourceDocument",
          }
        );
      }

      if (models.User) {
        TemporaryDocumentShare.belongsTo(
          models.User,
          {
            foreignKey:
              "createdBy",

            as: "creator",
          }
        );

        TemporaryDocumentShare.belongsTo(
          models.User,
          {
            foreignKey:
              "maskedBy",

            as: "masker",
          }
        );

        TemporaryDocumentShare.belongsTo(
          models.User,
          {
            foreignKey:
              "sentBy",

            as: "sender",
          }
        );

        TemporaryDocumentShare.belongsTo(
          models.User,
          {
            foreignKey:
              "revokedBy",

            as: "revoker",
          }
        );
      }

      if (models.Tenant) {
        TemporaryDocumentShare.belongsTo(
          models.Tenant,
          {
            foreignKey:
              "tenantId",

            as: "tenant",
          }
        );
      }
    };


  return TemporaryDocumentShare;
};