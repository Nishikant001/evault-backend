// src/models/tenantModels/DocumentContent.js
//
// Stores the actual binary content of a document inside the
// tenant-specific MySQL database.
//
// IMPORTANT:
// - This is intentionally separate from Document metadata.
// - One Document has at most one DocumentContent row.
// - Binary content is stored as MySQL LONGBLOB so the initial
//   50 MB/document limit is safely below the database column limit.
// - Tenant isolation is provided by the fact that this model is
//   instantiated through defineTenantModels(sequelize) against the
//   tenant's own physical database.

const { DataTypes } = require("sequelize");

module.exports = (sequelize) =>
  sequelize.define(
    "DocumentContent",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },

      documentId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
        references: {
          model: "documents",
          key: "id",
        },
      },

      content: {
        type: DataTypes.BLOB("long"),
        allowNull: false,
      },

      contentLength: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },

      checksumSha256: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
    },
    {
      tableName: "document_contents",
      timestamps: true,
    }
  );