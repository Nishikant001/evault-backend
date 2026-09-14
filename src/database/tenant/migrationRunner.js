// src/database/tenant/migrationRunner.js
//
// PHASE D — a small, dependency-free migration runner for TENANT
// databases specifically. Deliberately NOT sequelize-cli: sequelize-cli
// is wired to run against ONE configured connection (see
// src/config/masterConfig.js for the Master DB's own use of it) and has
// no first-class notion of "run this same migration set against
// whichever of N physical databases I hand you right now." Tenant
// migrations need exactly that — the same migration files, applied to
// a dynamically-created database chosen at runtime — so a purpose-built
// runner is the more honest fit than bending sequelize-cli sideways.
//
// Tracks applied migrations in a `tenant_schema_migrations` table
// inside the TENANT database itself (not the Master DB — each tenant
// database independently knows its own schema version), so:
//   - re-running provisioning after a partial failure only re-applies
//     what didn't finish (idempotent retry, brief section 10/11).
//   - this is genuinely a *migration* system, not just "call sync()
//     and hope" — there's a real, queryable record of what ran.
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable(sequelize) {
  const qi = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  if (!tables.includes("tenant_schema_migrations")) {
    await qi.createTable("tenant_schema_migrations", {
      id: { type: sequelize.Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: sequelize.Sequelize.STRING, allowNull: false, unique: true },
      appliedAt: { type: sequelize.Sequelize.DATE, allowNull: false },
    });
  }
}

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort(); // filenames are timestamp-prefixed, so lexical sort == chronological
}

/**
 * Apply every not-yet-applied tenant migration to `sequelize`, in order.
 * Safe to call repeatedly (idempotent) — already-applied migrations are
 * skipped based on the tenant_schema_migrations table.
 *
 * @param {import('sequelize').Sequelize} sequelize - an OPEN connection to the tenant's own database
 * @param {(event: string, detail?: object) => void} [onProgress] - optional structured-log hook
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
async function runTenantMigrations(sequelize, onProgress = () => {}) {
  await ensureMigrationsTable(sequelize);
  const qi = sequelize.getQueryInterface();
  const { Sequelize } = sequelize;

  const already = await sequelize.query(
    'SELECT name FROM tenant_schema_migrations',
    { type: sequelize.QueryTypes.SELECT },
  );
  const appliedSet = new Set(already.map((r) => r.name));

  const applied = [];
  const skipped = [];

  for (const file of listMigrationFiles()) {
    if (appliedSet.has(file)) {
      skipped.push(file);
      continue;
    }
    onProgress("MIGRATION_STARTED", { file });
    const migration = require(path.join(MIGRATIONS_DIR, file));
    await migration.up(qi, Sequelize, sequelize);
    await sequelize.query(
      "INSERT INTO tenant_schema_migrations (name, appliedAt) VALUES (:name, :appliedAt)",
      { replacements: { name: file, appliedAt: new Date() } },
    );
    applied.push(file);
    onProgress("MIGRATION_COMPLETED", { file });
  }

  return { applied, skipped };
}

module.exports = { runTenantMigrations, listMigrationFiles };
