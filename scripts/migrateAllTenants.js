// scripts/migrateAllTenants.js
//
// MERGE — Internal Communication Module (1-to-1 chat + voice messages).
//
// Applies any pending tenant migrations (currently: just
// 20260819000001-add-communication-tables.js) to every already-READY
// tenant database. Brand-new tenants provisioned after this merge don't
// need this — tenantProvisioningService.js already runs the full,
// current migration set (including the communication tables) as part of
// normal provisioning. This script exists solely to bring tenants that
// were provisioned BEFORE this merge up to date.
//
// Safe to re-run: runTenantMigrations() tracks what's already applied
// per-tenant-database in that database's own tenant_schema_migrations
// table, so already-migrated tenants are skipped automatically.
//
// Usage:  node scripts/migrateAllTenants.js
require("dotenv").config();
const masterSequelize = require("../src/config/masterDatabase");
const { TenantDatabase } = require("../src/models/masterDb");
const { runTenantMigrations } = require("../src/database/tenant/migrationRunner");
const { Sequelize } = require("sequelize");

const TENANT_DB_POOL = {
  max: Number(process.env.TENANT_DB_POOL_MAX || 5),
  min: 0,
  acquire: Number(process.env.TENANT_DB_POOL_ACQUIRE || 30000),
  idle: Number(process.env.TENANT_DB_POOL_IDLE || 10000),
};

async function main() {
  await masterSequelize.authenticate();
  console.log("✅ Master DB connected");

  const tenantDbs = await TenantDatabase.findAll({ where: { status: "READY" } });
  console.log(`Found ${tenantDbs.length} READY tenant database(s).`);

  const summary = [];

  for (const tenantDb of tenantDbs) {
    const sequelize = new Sequelize(
      tenantDb.databaseName,
      process.env.TENANT_DB_USER || process.env.MASTER_DB_USER,
      process.env.TENANT_DB_PASSWORD || process.env.MASTER_DB_PASSWORD,
      {
        host: process.env.TENANT_DB_HOST || process.env.MASTER_DB_HOST,
        port: process.env.TENANT_DB_PORT || process.env.MASTER_DB_PORT || 3306,
        dialect: "mysql",
        logging: false,
        pool: TENANT_DB_POOL,
      }
    );

    try {
      await sequelize.authenticate();
      const { applied, skipped } = await runTenantMigrations(sequelize, (event, detail) => {
        console.log(`  [tenant ${tenantDb.tenantId}] ${event}`, detail || "");
      });
      summary.push({ tenantId: tenantDb.tenantId, database: tenantDb.databaseName, applied, skipped });
    } catch (err) {
      console.error(`❌ Tenant ${tenantDb.tenantId} (${tenantDb.databaseName}) failed:`, err.message);
      summary.push({ tenantId: tenantDb.tenantId, database: tenantDb.databaseName, error: err.message });
    } finally {
      await sequelize.close().catch(() => {});
    }
  }

  console.log("\n── Migration summary ──────────────────────────");
  for (const s of summary) {
    if (s.error) {
      console.log(`Tenant ${s.tenantId}: FAILED — ${s.error}`);
    } else {
      console.log(`Tenant ${s.tenantId}: applied=[${s.applied.join(", ") || "none"}] skipped=${s.skipped.length}`);
    }
  }

  await masterSequelize.close();
  process.exit(summary.some((s) => s.error) ? 1 : 0);
}

main().catch((err) => {
  console.error("❌ migrateAllTenants failed:", err);
  process.exit(1);
});
