// src/models/CrossDepartmentDocumentRequest.js

"use strict";

module.exports = (sequelize, DataTypes) => {
  const CrossDepartmentDocumentRequest =
    sequelize.define(
      "CrossDepartmentDocumentRequest",
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

        requesterUserId: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: false,
          field: "requester_user_id",
        },

        requesterDepartmentId: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: false,
          field: "requester_department_id",
        },

        requestedDepartmentId: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: false,
          field: "requested_department_id",
        },

        documentReference: {
          type: DataTypes.STRING(500),
          allowNull: false,
          field: "document_reference",
        },

        reason: {
          type: DataTypes.TEXT,
          allowNull: true,
        },

        sourceDocumentId: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: true,
          field: "source_document_id",
        },

        sourceDocumentVersion: {
          type: DataTypes.STRING(100),
          allowNull: true,
          field: "source_document_version",
        },

               status: {
          type: DataTypes.ENUM(
            "PENDING",
            "DOCUMENT_SELECTED",
            "APPROVED",
            "SHARED",
            "REJECTED",
            "REVOKED",
            "EXPIRED"
          ),
          allowNull: false,
          defaultValue: "PENDING",
        },

        rejectionReason: {
          type: DataTypes.TEXT,
          allowNull: true,
          field: "rejection_reason",
        },

        rejectedBy: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: true,
          field: "rejected_by",
        },

        rejectedAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: "rejected_at",
        },

        approvedBy: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: true,
          field: "approved_by",
        },

        approvedAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: "approved_at",
        },
                shareId: {
          type: DataTypes.BIGINT.UNSIGNED,
          allowNull: true,
          field: "share_id",
        },
      },
      {
        tableName:
          "cross_department_document_requests",

        timestamps: true,

        underscored: true,

        indexes: [
          {
            name:
              "idx_cddr_tenant_status",
            fields: [
              "tenant_id",
              "status",
            ],
          },

          {
            name:
              "idx_cddr_requester",
            fields: [
              "tenant_id",
              "requester_user_id",
            ],
          },

          {
            name:
              "idx_cddr_requested_department",
            fields: [
              "tenant_id",
              "requested_department_id",
            ],
          },

          {
            name:
              "idx_cddr_source_document",
            fields: [
              "tenant_id",
              "source_document_id",
            ],
          },

          {
            name:
              "idx_cddr_document_reference",
            fields: [
              "tenant_id",
              "document_reference",
            ],
          },
        ],
      }
    );


  // ==========================================================
  // ASSOCIATIONS
  // ==========================================================

  CrossDepartmentDocumentRequest.associate =
    (models) => {

      if (models.User) {
        CrossDepartmentDocumentRequest.belongsTo(
          models.User,
          {
            foreignKey:
              "requesterUserId",

            as: "requester",
          }
        );
      }

      if (models.Document) {
        CrossDepartmentDocumentRequest.belongsTo(
          models.Document,
          {
            foreignKey:
              "sourceDocumentId",

            as: "sourceDocument",
          }
        );
      }

      if (models.Tenant) {
        CrossDepartmentDocumentRequest.belongsTo(
          models.Tenant,
          {
            foreignKey:
              "tenantId",

            as: "tenant",
          }
        );
      }

      if (models.Department) {
        CrossDepartmentDocumentRequest.belongsTo(
          models.Department,
          {
            foreignKey:
              "requesterDepartmentId",

            as: "requesterDepartment",
          }
        );

        CrossDepartmentDocumentRequest.belongsTo(
          models.Department,
          {
            foreignKey:
              "requestedDepartmentId",

            as: "requestedDepartment",
          }
        );
      }
       if (models.CrossDepartmentDocumentShare) {
        CrossDepartmentDocumentRequest.belongsTo(
          models.CrossDepartmentDocumentShare,
          {
            foreignKey: "shareId",
            as: "share",
          }
        );
      } 
    };


  return CrossDepartmentDocumentRequest;
};