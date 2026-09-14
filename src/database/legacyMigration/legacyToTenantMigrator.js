// src/database/legacyMigration/legacyToTenantMigrator.js
//
// PHASE F — core migration engine. One entry point per brief STEP:
//   dryRunTenant()   -> STEP 3  (read-only report, no writes at all)
//   migrateTenant()  -> STEP 5/6/7/9 (chunked, idempotent, resumable copy)
//   verifyTenant()   -> STEP 8  (post-migration row-count + FK integrity)
//
// Reuses, does NOT reimplement:
//   - TenantConnectionManager.openTenantSequelize() for the destination
//     connection (Phase C)
//   - defineTenantModels() for the destination model set (Phase B)
//   - eligibleTenantResolver.js for "which tenant, which database" (Step 4)
//   - tenantTableRegistry.js + scopeSql.js for "which legacy rows belong
//     to this tenant" (Step 1/2 audit output, turned into code)
const { Op } = require("sequelize");
const legacyModels = require("../../models");
const { openTenantSequelize } = require("../../services/tenantConnectionManager");
const { defineTenantModels } = require("../../models/tenantModels");
const masterModels = require("../../models/masterDb");
const { getMigrationOrder } = require("./tenantTableRegistry");
const { buildTenantScopeWhere } = require("./scopeSql");
const checkpoints = require("./checkpointStore");

const DEFAULT_CHUNK_SIZE = Number(process.env.LEGACY_MIGRATION_CHUNK_SIZE || 500);

// ─────────────────────────────────────────────────────────────────────
// STEP 3 — dry run. Never writes. Mirrors the report shape the brief
// itself specifies (Tenant / Source rows / Destination / Expected rows
// / Missing / Conflicts).
// ─────────────────────────────────────────────────────────────────────
async function dryRunTenant(eligibleTenant) {
  const { legacyTenantId, masterTenantId, tenantCode, tenantName, databaseName } = eligibleTenant;
  const { sequelize: tenantSequelize, models: tenantModels } = await openTenantSequelize(databaseName);

  const tables = [];
  try {
    for (const entry of getMigrationOrder()) {
      const legacyModel = legacyModels[entry.model];
      const tenantModel = tenantModels[entry.model];
      const where = buildTenantScopeWhere(legacyModels, entry, legacyTenantId);

      const sourceRows = await legacyModel.count({ where });
      const destRowsBefore = await tenantModel.count();

      // Conflicts: legacy ids that ALREADY exist in the destination table.
      // A resumed/idempotent re-run is expected to show these (that's the
      // point of idempotency) — the dry-run reports the number so an
      // operator can distinguish "resuming a known migration" from "this
      // tenant DB already has unrelated data in it," which is exactly
      // what Step 7 asks to be able to detect.
      const sourceIdRows = await legacyModel.findAll({ where, attributes: ["id"], raw: true });
      const sourceIds = sourceIdRows.map((r) => r.id);
      let conflicts = 0;
      if (sourceIds.length > 0) {
        conflicts = await tenantModel.count({ where: { id: { [Op.in]: sourceIds } } });
      }

      tables.push({
        table: entry.model,
        sourceRows,
        destinationExistingRows: destRowsBefore,
        expectedAfterMigration: destRowsBefore - conflicts + sourceRows,
        wouldInsertOrUpdate: sourceRows,
        conflicts, // rows that would be UPDATEd (already present by id), not newly inserted
      });
    }
  } finally {
    await tenantSequelize.close();
  }

  return { legacyTenantId, masterTenantId, tenantCode, tenantName, databaseName, tables };
}

// ─────────────────────────────────────────────────────────────────────
// STEP 5/6/7/9 — actual migration for one tenant. Idempotent: every
// insert is INSERT ... ON DUPLICATE KEY UPDATE on the primary key, so a
// crashed/resumed run cannot duplicate rows. Chunked by keyset
// pagination (id > lastId), never loads a whole table into memory.
// ─────────────────────────────────────────────────────────────────────
async function migrateTenant(eligibleTenant, { chunkSize = DEFAULT_CHUNK_SIZE, resume = true } = {}) {
  const { legacyTenantId, masterTenantId, databaseName } = eligibleTenant;
  const { sequelize: tenantSequelize, models: tenantModels } = await openTenantSequelize(databaseName);
  await checkpoints.ensureCheckpointTable(tenantSequelize);

  const results = [];
  try {
    for (const entry of getMigrationOrder()) {
      const result = await migrateOneTable(tenantSequelize, tenantModels, entry, legacyTenantId, { chunkSize, resume });
      results.push(result);
    }

    // Document.parentDocumentId — self-referential FK, backfilled in a
    // second pass once every Document row for this tenant has its id
    // preserved in the destination (see tenantTableRegistry.js comment).
    const docEntry = getMigrationOrder().find((e) => e.model === "Document");
    if (docEntry) {
      await backfillSelfReferentialColumn(tenantSequelize, docEntry, legacyTenantId);
    }

    // Users migrated -> keep GlobalUserIndex (Master DB) in sync so the
    // real login flow's tier-2 lookup (email -> tenant DB) finds these
    // users instead of falling through to the legacy tier-3 fallback.
    // This is a necessary side effect of migrating Users, not new scope:
    // GlobalUserIndex already exists (Phase D) specifically for this.
    const userResult = results.find((r) => r.table === "User");
    if (userResult) {
      userResult.globalUserIndex = await backfillGlobalUserIndex(tenantModels, masterTenantId);
    }
  } finally {
    await tenantSequelize.close();
  }

  return { legacyTenantId, masterTenantId, databaseName, tables: results };
}

async function migrateOneTable(tenantSequelize, tenantModels, entry, legacyTenantId, { chunkSize, resume }) {
  const legacyModel = legacyModels[entry.model];
  const tenantModel = tenantModels[entry.model];
  const where = buildTenantScopeWhere(legacyModels, entry, legacyTenantId);

  const existingCheckpoint = resume ? await checkpoints.getCheckpoint(tenantSequelize, entry.model) : null;
  if (existingCheckpoint && existingCheckpoint.status === "COMPLETE") {
    return { table: entry.model, skipped: true, reason: "checkpoint already COMPLETE", rowsMigrated: existingCheckpoint.rowsMigrated };
  }
  if (!existingCheckpoint) {
    await checkpoints.startCheckpoint(tenantSequelize, entry.model);
  }

  let lastId = existingCheckpoint?.lastMigratedLegacyId || 0;
  let rowsMigrated = existingCheckpoint?.rowsMigrated || 0;
  const attributes = Object.keys(legacyModel.rawAttributes);
  const selfRefColumn = entry.selfReferential?.column;

  for (;;) {
    const batch = await legacyModel.findAll({
      where: { ...where, id: { [Op.gt]: lastId } },
      order: [["id", "ASC"]],
      limit: chunkSize,
      attributes,
      raw: true,
    });
    if (batch.length === 0) break;

    const rowsToInsert = batch.map((row) => {
      const copy = { ...row };
      // Self-referential FK deferred to the second pass — see comment above.
      if (selfRefColumn) copy[selfRefColumn] = null;
      return copy;
    });

    await tenantModel.bulkCreate(rowsToInsert, {
      updateOnDuplicate: attributes.filter((a) => a !== "id"),
      validate: false,
    });

    lastId = batch[batch.length - 1].id;
    rowsMigrated += batch.length;
    await checkpoints.advanceCheckpoint(tenantSequelize, entry.model, {
      lastMigratedLegacyId: lastId,
      rowsMigratedIncrement: batch.length,
    });

    if (batch.length < chunkSize) break;
  }

  await checkpoints.completeCheckpoint(tenantSequelize, entry.model);
  return { table: entry.model, skipped: false, rowsMigrated };
}

async function backfillSelfReferentialColumn(tenantSequelize, entry, legacyTenantId) {
  const legacyModel = legacyModels[entry.model];
  const where = buildTenantScopeWhere(legacyModels, entry, legacyTenantId);
  const column = entry.selfReferential.column;
  const tableName = legacyModel.getTableName();

  const pairs = await legacyModel.findAll({
    where: { ...where, [column]: { [Op.ne]: null } },
    attributes: ["id", column],
    raw: true,
  });

  let updated = 0;
  for (const pair of pairs) {
    await tenantSequelize.query(`UPDATE \`${tableName}\` SET \`${column}\` = ? WHERE \`id\` = ?`, {
      replacements: [pair[column], pair.id],
    });
    updated++;
  }
  return { table: entry.model, selfReferentialBackfilled: updated };
}

async function backfillGlobalUserIndex(tenantModels, masterTenantId) {
  const users = await tenantModels.User.findAll({ attributes: ["id", "email", "mobileNumber"], raw: true });
  let created = 0;
  const conflicts = [];
  for (const user of users) {
    if (!user.email) continue;
    try {
      const [, wasCreated] = await masterModels.GlobalUserIndex.findOrCreate({
        where: { email: user.email },
        defaults: { email: user.email, mobileNumber: user.mobileNumber || null, tenantId: masterTenantId, tenantUserId: user.id },
      });
      if (wasCreated) created++;
      else {
        const existing = await masterModels.GlobalUserIndex.findOne({ where: { email: user.email }, raw: true });
        if (existing && existing.tenantId !== masterTenantId) {
          conflicts.push({ email: user.email, existingTenantId: existing.tenantId, thisTenantId: masterTenantId });
        }
      }
    } catch (err) {
      conflicts.push({ email: user.email, error: err.message });
    }
  }
  return { usersConsidered: users.length, indexRowsCreated: created, conflicts };
}

// ─────────────────────────────────────────────────────────────────────
// STEP 8 — verification. Row counts + generic FK-orphan checks built
// from the tenant models' OWN associations (tenantModels/index.js),
// so this does not hardcode a second copy of the FK graph.
// ─────────────────────────────────────────────────────────────────────
async function verifyTenant(eligibleTenant) {
  const { legacyTenantId, databaseName } = eligibleTenant;
  const { sequelize: tenantSequelize, models: tenantModels } = await openTenantSequelize(databaseName);

  const rowCounts = [];
  try {
    for (const entry of getMigrationOrder()) {
      const legacyModel = legacyModels[entry.model];
      const tenantModel = tenantModels[entry.model];
      const where = buildTenantScopeWhere(legacyModels, entry, legacyTenantId);
      const sourceCount = await legacyModel.count({ where });
      const destCount = await tenantModel.count();
      rowCounts.push({ table: entry.model, sourceCount, destCount, match: sourceCount === destCount });
    }

    const integrity = await checkReferentialIntegrity(tenantSequelize, tenantModels);

    return { legacyTenantId, databaseName, rowCounts, integrity };
  } finally {
    await tenantSequelize.close();
  }
}

async function checkReferentialIntegrity(tenantSequelize, tenantModels) {
  const findings = [];
  for (const [modelName, Model] of Object.entries(tenantModels)) {
    for (const assoc of Object.values(Model.associations || {})) {
      if (assoc.associationType !== "BelongsTo") continue;
      const fk = assoc.foreignKey;
      const childTable = Model.getTableName();
      const parentTable = assoc.target.getTableName();
      if (!Model.rawAttributes[fk]) continue;

      const [rows] = await tenantSequelize.query(
        `SELECT COUNT(*) AS cnt FROM \`${childTable}\` c
         WHERE c.\`${fk}\` IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM \`${parentTable}\` p WHERE p.\`id\` = c.\`${fk}\`)`,
      );
      const missing = Number(rows[0].cnt);
      findings.push({ check: `${modelName} with missing ${assoc.target.name} (${fk})`, missing });
    }
  }
  return findings;
}

module.exports = { dryRunTenant, migrateTenant, verifyTenant };
