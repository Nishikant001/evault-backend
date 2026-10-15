// src/models/tenantModels/SapSyncRetryQueue.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/SapSyncRetryQueue.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// One row per SAP record that failed to synchronize (master or document).
// The retry scheduler (sapSyncScheduler.js / sapRetryQueueService.js) picks
// up PENDING/RETRYING rows whose nextRetryAt has passed, re-attempts them,
// and records every attempt in `history` — this is the "retry history"
// required by the brief, kept separate from the per-run SapSyncLog so a
// single stubborn record's story can be traced across many sync runs.
module.exports = (sequelize) => sequelize.define(
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
    },
    // MULTI-ERP FIX (see migration 20260924000001-add-erpconfigid-to-retry-queue.js):
    // which of the tenant's (possibly several) active SAP ERP connections
    // produced this failure. Nullable so pre-existing rows created before
    // this column existed keep working unmodified — they're simply not
    // tied to a specific ERP and are only picked up when a retry is run
    // WITHOUT an erpConfigId filter (the old, tenant-wide behavior).
    //
    // Retrying a specific ERP (POST /sap-sync/retry { erpConfigId }) must
    // only ever re-attempt rows that failed against THAT ERP, using THAT
    // ERP's own configuration — never a different ERP's, and never the
    // tenant's default. See sapRetryQueueService.js / sapSyncOrchestrator.js.
    erpConfigId: {
      type: DataTypes.INTEGER,
      allowNull: true,
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
      // MULTI-ERP FIX: erpConfigId joined the uniqueness key (see the
      // migration for the matching addIndex/removeIndex on already-
      // provisioned tenant databases) — a record with the same reference
      // code failing against two different ERP connections is now two
      // distinct queue rows instead of one row that only remembers the
      // most recent ERP's error.
      { fields: ["tenantId", "erpConfigId", "entityType", "referenceCode"], unique: true, name: "unique_retry_item_per_tenant_erp" },
      { fields: ["status", "nextRetryAt"] },
      { fields: ["tenantId", "erpConfigId"] },
    ],
  }
);