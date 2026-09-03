const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Per-tenant, per-job schedule config for the SAP Sync Scheduler page.
// See services/sapSyncScheduler.js — it reads these rows to decide whether
// and how often to run each job per tenant, replacing the old single
// global env-var cron.
const SapSyncSchedule = sequelize.define(
  "SapSyncSchedule",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "tenants", key: "id" },
    },
    jobName: {
      type: DataTypes.ENUM("MASTER_SYNC", "DOCUMENT_SYNC", "RETRY_SYNC"),
      allowNull: false,
    },
    label: { type: DataTypes.STRING, allowNull: false },
    cronExpression: { type: DataTypes.STRING, allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastRunAt: { type: DataTypes.DATE, allowNull: true },
    lastRunStatus: {
      type: DataTypes.ENUM("SUCCESS", "PARTIAL_SUCCESS", "FAILED"),
      allowNull: true,
    },
    lastDurationMs: { type: DataTypes.INTEGER, allowNull: true },
    lastSyncLogId: { type: DataTypes.INTEGER, allowNull: true },
    updatedBy: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: "sap_sync_schedules",
    timestamps: true,
    indexes: [{ fields: ["tenantId", "jobName"], unique: true, name: "unique_schedule_job_per_tenant" }],
  }
);

module.exports = SapSyncSchedule;
