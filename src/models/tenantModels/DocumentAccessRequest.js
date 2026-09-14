// src/models/tenantModels/DocumentAccessRequest.js
//
// Cross-Department Document Access Request
//
// IMPORTANT:
// - This is a TENANT database model.
// - Department IDs are plain integers because Department lives
//   in the Master DB.
// - The requester NEVER supplies sourceDocumentId.
// - sourceDocumentId remains NULL until an authorized owner
//   selects an existing DMS document.
// - No document binary is stored here.
// - No new permanent Document is created for sharing.
//

"use strict";

const { DataTypes } = require("sequelize");

module.exports = (sequelize) =>
  sequelize.define(
    "DocumentAccessRequest",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },

      // ========================================================
      // TENANT
      // ========================================================

      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      // ========================================================
      // REQUESTER
      // ========================================================

      requesterUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,

        references: {
          model: "users",
          key: "id",
        },
      },

      requesterDepartmentId: {
        type: DataTypes.INTEGER,
        allowNull: true,

        // Nullable: the requester is asking for a document from
        // ANOTHER department (that's the whole point of this
        // feature), so the requester is not expected to belong to
        // the requested department. This field is kept only as
        // optional context/audit info when it happens to be known
        // — it is never a gate on whether the request can be made.
        //
        // Department is in MASTER DB.
        // Therefore no cross-database FK is declared.
      },

      // ========================================================
      // REQUESTED DEPARTMENT
      // ========================================================

      requestedDepartmentId: {
        type: DataTypes.INTEGER,
        allowNull: false,

        // Department is in MASTER DB.
        // Therefore no cross-database FK is declared.
      },

      // ========================================================
      // RECIPIENT
      // ========================================================
      //
      // The requester automatically becomes the recipient.
      // Keeping this explicitly stored makes the share lifecycle
      // independent from future user/request changes.
      //

      recipientUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,

        references: {
          model: "users",
          key: "id",
        },
      },

      // ========================================================
      // REQUEST INFORMATION
      // ========================================================

      documentReference: {
        type: DataTypes.STRING(500),
        allowNull: false,
      },

      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      // ========================================================
      // SOURCE DOCUMENT
      // ========================================================
      //
      // NULL when request is first created.
      //
      // This MUST point to an EXISTING DMS Document.
      // No upload is performed by requester or owner.
      //

      sourceDocumentId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },

      // If the existing DMS implementation supports document
      // versions, store the exact selected version here.
      //

      sourceDocumentVersion: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      // ========================================================
      // REQUEST STATUS
      // ========================================================

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

      // ========================================================
      // APPROVAL
      // ========================================================

      grantedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,

        references: {
          model: "users",
          key: "id",
        },
      },

      grantedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      // ========================================================
      // REJECTION
      // ========================================================

      rejectedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,

        references: {
          model: "users",
          key: "id",
        },
      },

      rejectedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      rejectionReason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      // ========================================================
      // ROUTING / OWNER HANDLING
      // ========================================================

      handledBy: {
        type: DataTypes.INTEGER,
        allowNull: true,

        references: {
          model: "users",
          key: "id",
        },

        comment:
          "Authorized department owner/user currently handling the request",
      },

      handledAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      // ========================================================
      // TIMESTAMPS
      // ========================================================
      //
      // Sequelize automatically manages createdAt / updatedAt.
      //
    },

    {
      tableName: "document_access_requests",

      timestamps: true,

      indexes: [
        // Tenant isolation / common lookup
        {
          fields: [
            "tenantId",
          ],
        },

        // Requested department queue
        {
          fields: [
            "tenantId",
            "requestedDepartmentId",
          ],
        },

        // Requester's requests
        {
          fields: [
            "tenantId",
            "requesterUserId",
          ],
        },

        // Recipient lookup
        {
          fields: [
            "tenantId",
            "recipientUserId",
          ],
        },

        // Source document lookup
        {
          fields: [
            "tenantId",
            "sourceDocumentId",
          ],
        },

        // Queue/status filtering
        {
          fields: [
            "tenantId",
            "status",
          ],
        },

        // Useful for request-reference searching
        {
          fields: [
            "tenantId",
            "documentReference",
          ],
        },
      ],
    }
  );