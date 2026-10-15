// src/database/tenant/migrations/20260924000001-add-erpconfigid-to-retry-queue.js
//
// MULTI-ERP SYNC — Retry Queue ERP awareness.
//
// Problem this fixes:
//
// A tenant with multiple active SAP ERP connections could have the SAME
// referenceCode (e.g. Department code "1000") fail against ERP 1 while
// succeeding against ERP 2. Before this migration, `sap_sync_retry_queue`
// had no erpConfigId column at all, so:
//   - both failures collapsed onto ONE row keyed only by
//     (tenantId, entityType, referenceCode) — the second ERP's error
//     silently overwrote the first ERP's history.
//   - POST /api/sap-sync/retry had no way to retry "only what failed for
//     ERP 2" — it always retried everything for the tenant, and any retry
//     that needed to re-contact SAP had no way to know which ERP
//     connection to use.
//
// This migration, together with the updated model
// (src/models/tenantModels/SapSyncRetryQueue.js) and the updated
// sapRetryQueueService.js / sapSyncOrchestrator.js / sapSyncController.js,
// makes the retry queue ERP-specific end-to-end.
//
// Step 1: defineTenantModels() + sequelize.sync() — same safe,
// non-destructive pattern used by every other tenant migration in this
// folder. Without `force`/`alter`, sync() only CREATES tables that don't
// exist yet (a tenant somehow missing sap_sync_retry_queue entirely gets
// it created already correct, with erpConfigId); it never touches a
// table that already exists.
//
// Step 2: for tenants where sap_sync_retry_queue already existed (the
// common case), explicitly add the erpConfigId column and swap the old
// 3-column unique index for the new 4-column one that includes it.
// Every step below is written to be safe to re-run (idempotent) — it
// checks before adding/removing so a partially-applied run, or being
// re-run by mistake, never errors out or duplicates state.
//
// Nothing existing is destroyed: pre-existing rows simply get
// erpConfigId = NULL, which sapRetryQueueService.js treats as "not tied
// to a specific ERP" and keeps handling exactly as before.
module.exports = {
  async up(queryInterface, Sequelize, sequelize) {
    const { defineTenantModels } = require("../../../models/tenantModels");
    defineTenantModels(sequelize);
    await sequelize.sync();

    const table = await queryInterface.describeTable("sap_sync_retry_queue");

    if (!table.erpConfigId) {
      await queryInterface.addColumn("sap_sync_retry_queue", "erpConfigId", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    let existingIndexes = [];
    try {
      existingIndexes = await queryInterface.showIndex("sap_sync_retry_queue");
    } catch (error) {
      existingIndexes = [];
    }

    const hasOldUniqueIndex = existingIndexes.some(
      (idx) => idx.name === "unique_retry_item_per_tenant",
    );
    const hasNewUniqueIndex = existingIndexes.some(
      (idx) => idx.name === "unique_retry_item_per_tenant_erp",
    );
    const hasErpLookupIndex = existingIndexes.some(
      (idx) => idx.name === "sap_sync_retry_queue_tenant_id_erp_config_id",
    );

    if (hasOldUniqueIndex) {
      await queryInterface.removeIndex(
        "sap_sync_retry_queue",
        "unique_retry_item_per_tenant",
      );
    }

    if (!hasNewUniqueIndex) {
      await queryInterface.addIndex(
        "sap_sync_retry_queue",
        ["tenantId", "erpConfigId", "entityType", "referenceCode"],
        { unique: true, name: "unique_retry_item_per_tenant_erp" },
      );
    }

    if (!hasErpLookupIndex) {
      await queryInterface.addIndex(
        "sap_sync_retry_queue",
        ["tenantId", "erpConfigId"],
      );
    }
  },

  async down(queryInterface) {
    // Not reverted automatically — same "no destructive auto-down" stance
    // as the other tenant migrations in this folder (e.g.
    // 20260826000001-make-requester-department-nullable.js). Dropping the
    // column would silently lose which ERP each queued failure belongs
    // to. Revert manually, outside the migration runner, only if truly
    // required.
  },
};