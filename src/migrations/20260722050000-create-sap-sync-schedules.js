"use strict";

// One row per (tenant, job) — the three jobs the existing cron engine in
// sapSyncScheduler.js already runs (MASTER_SYNC, DOCUMENT_SYNC, RETRY_SYNC).
// This table lets the Scheduler Management screen control frequency/enabled
// state per tenant instead of the old single global env-var cron for
// everyone. Rows are auto-provisioned (findOrCreate) the first time a
// tenant's schedules are listed, so no manual seeding is required.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("sap_sync_schedules", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onDelete: "CASCADE",
      },
      jobName: {
        type: Sequelize.ENUM("MASTER_SYNC", "DOCUMENT_SYNC", "RETRY_SYNC"),
        allowNull: false,
      },
      label: { type: Sequelize.STRING, allowNull: false },
      cronExpression: { type: Sequelize.STRING, allowNull: false },
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      lastRunAt: { type: Sequelize.DATE, allowNull: true },
      lastRunStatus: {
        type: Sequelize.ENUM("SUCCESS", "PARTIAL_SUCCESS", "FAILED"),
        allowNull: true,
      },
      lastDurationMs: { type: Sequelize.INTEGER, allowNull: true },
      lastSyncLogId: { type: Sequelize.INTEGER, allowNull: true },
      updatedBy: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("sap_sync_schedules", ["tenantId", "jobName"], {
      unique: true,
      name: "unique_schedule_job_per_tenant",
    });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable("sap_sync_schedules");
  },
};
