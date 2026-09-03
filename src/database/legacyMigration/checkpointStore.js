// src/database/legacyMigration/checkpointStore.js
//
// PHASE F — STEP 9 (brief): "The migration must be safely repeatable.
// If migration stops at 60%, rerunning it must NOT corrupt data."
//
// Progress is tracked INSIDE each tenant's own physical database, in a
// small `_legacy_migration_checkpoints` table (one row per source table
// per tenant). This is deliberately not a file or a Master DB table:
// the checkpoint must live and die with the tenant database it describes,
// so a tenant DB backup/restore automatically carries its own migration
// state with it.
//
// Idempotency is belt-and-braces, not checkpoint-only: table inserts
// themselves use INSERT ... ON DUPLICATE KEY (bulkCreate with
// updateOnDuplicate on the primary key — see legacyToTenantMigrator.js),
// so even a resume from a stale/lost checkpoint cannot create duplicate
// rows. The checkpoint's real job is to let --resume skip already-
// completed tables quickly rather than re-scan them.
const { DataTypes } = require("sequelize");

async function ensureCheckpointTable(tenantSequelize) {
  const qi = tenantSequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  if (tables.includes("_legacy_migration_checkpoints")) return;

  await qi.createTable("_legacy_migration_checkpoints", {
    tableName: { type: DataTypes.STRING, primaryKey: true }, // legacy model name, e.g. "Document"
    status: { type: DataTypes.ENUM("IN_PROGRESS", "COMPLETE"), allowNull: false, defaultValue: "IN_PROGRESS" },
    lastMigratedLegacyId: { type: DataTypes.INTEGER, allowNull: true },
    rowsMigrated: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    startedAt: { type: DataTypes.DATE, allowNull: false },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
}

async function getCheckpoint(tenantSequelize, tableName) {
  const [rows] = await tenantSequelize.query(
    "SELECT * FROM `_legacy_migration_checkpoints` WHERE `tableName` = ?",
    { replacements: [tableName] },
  );
  return rows[0] || null;
}

async function startCheckpoint(tenantSequelize, tableName) {
  const now = new Date();
  await tenantSequelize.query(
    `INSERT INTO \`_legacy_migration_checkpoints\` (\`tableName\`, \`status\`, \`lastMigratedLegacyId\`, \`rowsMigrated\`, \`startedAt\`, \`updatedAt\`)
     VALUES (?, 'IN_PROGRESS', NULL, 0, ?, ?)
     ON DUPLICATE KEY UPDATE \`status\` = 'IN_PROGRESS', \`updatedAt\` = VALUES(\`updatedAt\`)`,
    { replacements: [tableName, now, now] },
  );
}

async function advanceCheckpoint(tenantSequelize, tableName, { lastMigratedLegacyId, rowsMigratedIncrement }) {
  await tenantSequelize.query(
    `UPDATE \`_legacy_migration_checkpoints\`
     SET \`lastMigratedLegacyId\` = ?, \`rowsMigrated\` = \`rowsMigrated\` + ?, \`updatedAt\` = ?
     WHERE \`tableName\` = ?`,
    { replacements: [lastMigratedLegacyId, rowsMigratedIncrement, new Date(), tableName] },
  );
}

async function completeCheckpoint(tenantSequelize, tableName) {
  await tenantSequelize.query(
    `UPDATE \`_legacy_migration_checkpoints\` SET \`status\` = 'COMPLETE', \`completedAt\` = ?, \`updatedAt\` = ? WHERE \`tableName\` = ?`,
    { replacements: [new Date(), new Date(), tableName] },
  );
}

module.exports = { ensureCheckpointTable, getCheckpoint, startCheckpoint, advanceCheckpoint, completeCheckpoint };
