"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // ==========================================================
    // 1. DOCUMENT ACCESS REQUESTS
    // ==========================================================

    await queryInterface.createTable(
      "document_access_requests",
      {
        id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
        },

        tenantId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },

        requesterUserId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },

        requesterDepartmentId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },

        requestedDepartmentId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },

        recipientUserId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },

        documentReference: {
          type: Sequelize.STRING(500),
          allowNull: false,
        },

        reason: {
          type: Sequelize.TEXT,
          allowNull: true,
        },

        sourceDocumentId: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },

        sourceDocumentVersion: {
          type: Sequelize.STRING(100),
          allowNull: true,
        },

        status: {
          type: Sequelize.ENUM(
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

        grantedBy: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },

        grantedAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },

        rejectedBy: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },

        rejectedAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },

        rejectionReason: {
          type: Sequelize.TEXT,
          allowNull: true,
        },

        handledBy: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },

        handledAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },

        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal(
            "CURRENT_TIMESTAMP"
          ),
        },

        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal(
            "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
          ),
        },
      }
    );

    // ==========================================================
    // REQUEST INDEXES
    // ==========================================================

    await queryInterface.addIndex(
      "document_access_requests",
      ["tenantId"],
      {
        name:
          "idx_dar_tenant",
      }
    );

    await queryInterface.addIndex(
      "document_access_requests",
      [
        "tenantId",
        "requestedDepartmentId",
      ],
      {
        name:
          "idx_dar_requested_department",
      }
    );

    await queryInterface.addIndex(
      "document_access_requests",
      [
        "tenantId",
        "requesterUserId",
      ],
      {
        name:
          "idx_dar_requester",
      }
    );

    await queryInterface.addIndex(
      "document_access_requests",
      [
        "tenantId",
        "sourceDocumentId",
      ],
      {
        name:
          "idx_dar_source_document",
      }
    );

    await queryInterface.addIndex(
      "document_access_requests",
      [
        "tenantId",
        "recipientUserId",
      ],
      {
        name:
          "idx_dar_recipient",
      }
    );

    await queryInterface.addIndex(
      "document_access_requests",
      [
        "tenantId",
        "status",
      ],
      {
        name:
          "idx_dar_status",
      }
    );


    // ==========================================================
    // 2. CROSS DEPARTMENT DOCUMENT SHARES
    // ==========================================================

    await queryInterface.createTable(
      "cross_department_document_shares",
      {
        id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
        },

        tenantId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },

        requestId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },

        recipientUserId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },

        sourceDocumentId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },

        sourceDocumentVersion: {
          type: Sequelize.STRING(100),
          allowNull: true,
        },

        temporaryStorageKey: {
          type: Sequelize.STRING(1000),
          allowNull: true,
        },

        temporaryFileName: {
          type: Sequelize.STRING(500),
          allowNull: true,
        },

        temporaryMimeType: {
          type: Sequelize.STRING(255),
          allowNull: true,
        },

        maskingRequired: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },

        maskingData: {
          type: Sequelize.JSON,
          allowNull: true,
        },

        maskedAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },

        maskedBy: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },

        status: {
          type: Sequelize.ENUM(
            "PREPARED",
            "ACTIVE",
            "REVOKED",
            "EXPIRED"
          ),
          allowNull: false,
          defaultValue: "PREPARED",
        },

        expiresAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },

        sentAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },

        sentBy: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },

        revokedAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },

        revokedBy: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },

        revokeReason: {
          type: Sequelize.TEXT,
          allowNull: true,
        },

        cleanedAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },

        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal(
            "CURRENT_TIMESTAMP"
          ),
        },

        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal(
            "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
          ),
        },
      }
    );

    // ==========================================================
    // SHARE INDEXES
    // ==========================================================

    await queryInterface.addIndex(
      "cross_department_document_shares",
      [
        "tenantId",
        "requestId",
      ],
      {
        name:
          "idx_cdshare_request",
      }
    );

    await queryInterface.addIndex(
      "cross_department_document_shares",
      [
        "tenantId",
        "sourceDocumentId",
      ],
      {
        name:
          "idx_cdshare_source_document",
      }
    );

    await queryInterface.addIndex(
      "cross_department_document_shares",
      [
        "tenantId",
        "recipientUserId",
      ],
      {
        name:
          "idx_cdshare_recipient",
      }
    );

    await queryInterface.addIndex(
      "cross_department_document_shares",
      [
        "tenantId",
        "status",
      ],
      {
        name:
          "idx_cdshare_status",
      }
    );

    await queryInterface.addIndex(
      "cross_department_document_shares",
      ["expiresAt"],
      {
        name:
          "idx_cdshare_expires_at",
      }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable(
      "cross_department_document_shares"
    );

    await queryInterface.dropTable(
      "document_access_requests"
    );
  },
};