// src/database/tenant/seederRunner.js
//
// PHASE D — same pattern as migrationRunner.js, for tenant SEED data
// instead of schema. Separate tracking table (tenant_schema_seeders) so
// migrations and seeders are independently idempotent/retry-safe — a
// retried provisioning attempt that already applied the schema but
// failed before seeding only re-runs seeding, not schema creation.
const fs = require("fs");
const path = require("path");

const SEEDERS_DIR = path.join(__dirname, "seeders");

async function ensureSeedersTable(sequelize) {
  const qi = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  if (!tables.includes("tenant_schema_seeders")) {
    await qi.createTable("tenant_schema_seeders", {
      id: { type: sequelize.Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: sequelize.Sequelize.STRING, allowNull: false, unique: true },
      appliedAt: { type: sequelize.Sequelize.DATE, allowNull: false },
    });
  }
}

function listSeederFiles() {
  return fs
    .readdirSync(SEEDERS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort();
}

/**
 * Run every not-yet-applied tenant seeder against `models` (the factory
 * model set already bound to the tenant's own connection). Idempotent —
 * safe to call again on a provisioning retry.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {ReturnType<typeof import('../../models/tenantModels').defineTenantModels>} models
 * @param {{ tenantId: number }} context
 * @param {(event: string, detail?: object) => void} [onProgress]
 */
async function runTenantSeeders(sequelize, models, context, onProgress = () => {}) {
  await ensureSeedersTable(sequelize);

  const already = await sequelize.query(
    "SELECT name FROM tenant_schema_seeders",
    { type: sequelize.QueryTypes.SELECT },
  );
  const appliedSet = new Set(already.map((r) => r.name));

  const applied = [];
  const skipped = [];

  for (const file of listSeederFiles()) {
    if (appliedSet.has(file)) {
      skipped.push(file);
      continue;
    }
    onProgress("SEEDER_STARTED", { file });
    const seeder = require(path.join(SEEDERS_DIR, file));
    await seeder.run(models, context);
    await sequelize.query(
      "INSERT INTO tenant_schema_seeders (name, appliedAt) VALUES (:name, :appliedAt)",
      { replacements: { name: file, appliedAt: new Date() } },
    );
    applied.push(file);
    onProgress("SEEDER_COMPLETED", { file });
  }

  return { applied, skipped };
}

module.exports = { runTenantSeeders, listSeederFiles };
