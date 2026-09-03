const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// One row per SAP record that failed to synchronize (master or document).
// The retry scheduler (sapSyncScheduler.js / sapRetryQueueService.js) picks
// up PENDING/RETRYING rows whose nextRetryAt has passed, re-attempts them,
// and records every attempt in `history` — this is the "retry history"
// required by the brief, kept separate from the per-run SapSyncLog so a
// single stubborn record's story can be traced across many sync runs.
const SapSyncRetryQueue = sequelize.define(
  "SapSyncRetryQueue",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "tenants", key: "id" },
    },
    entityType: {
      type: DataTypes.ENUM("DEPARTMENT", "CATEGORY", "DOCUMENT_TYPE", "DOCUMENT"),
      allowNull: false,
    },
    // Business key of the failing record — the SAP code for master rows,
    // or the SAP DocumentId for document rows. Used for idempotent
    // de-duplication (don't queue the same failing record twice).
    referenceCode: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    // The raw, normalized SAP record that failed, so retry doesn't need to
    // re-fetch it individually from SAP.
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("PENDING", "RETRYING", "RESOLVED", "ABANDONED"),
      allowNull: false,
      defaultValue: "PENDING",
    },
    attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    maxAttempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 5,
    },
    lastError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    nextRetryAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: DataTypes.NOW,
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Array of { attempt, error, timestamp }
    history: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    sapSyncLogId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "sap_sync_logs", key: "id" },
      comment: "The sync run that originally produced this failure",
    },
  },
  {
    tableName: "sap_sync_retry_queue",
    timestamps: true,
    indexes: [
      { fields: ["tenantId", "entityType", "referenceCode"], unique: true, name: "unique_retry_item_per_tenant" },
      { fields: ["status", "nextRetryAt"] },
    ],
  }
);

module.exports = SapSyncRetryQueue;
