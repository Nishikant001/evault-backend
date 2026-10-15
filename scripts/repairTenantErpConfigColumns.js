// Run from backend root:
//   node scripts/repairTenantErpConfigColumns.js          (dry run)
//   node scripts/repairTenantErpConfigColumns.js --apply  (add missing nullable columns)
// Uses MASTER_DB_NAME and the tenant_databases registry used by this backend.
// Only READY tenant databases are considered. No tables or rows are dropped.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { DataTypes } = require("sequelize");
const masterModels = require("../src/models/masterDb");
const { openTenantSequelize } = require("../src/services/tenantConnectionManager");

const APPLY = process.argv.includes("--apply");
const TARGETS = ["categories", "document_types"];

function normalizeTableNames(names) {
  return new Map(names.map((name) => [String(name).toLowerCase(), String(name)]));
}

async function repairTenant(row) {
  const tenantId = row.tenantId;
  const databaseName = row.databaseName;
  if (!databaseName || !/^[A-Za-z0-9_]+$/.test(databaseName)) {
    console.error(`[SKIP] tenantId=${tenantId}: unsafe or empty databaseName`);
    return { checked: 0, changed: 0, failed: 1 };
  }

  let connection;
  let changed = 0;
  try {
    connection = await openTenantSequelize(databaseName);
    const qi = connection.sequelize.getQueryInterface();
    const tableNames = normalizeTableNames(await qi.showAllTables());

    for (const requestedTable of TARGETS) {
      const actualTable = tableNames.get(requestedTable.toLowerCase());
      if (!actualTable) {
        throw new Error(`Required table "${requestedTable}" was not found`);
      }
      const columns = await qi.describeTable(actualTable);
      if (columns.erpConfigId) {
        console.log(`[OK] tenantId=${tenantId} db=${databaseName} table=${actualTable}: erpConfigId exists`);
        continue;
      }

      if (!APPLY) {
        console.log(`[DRY RUN] tenantId=${tenantId} db=${databaseName} table=${actualTable}: would add nullable erpConfigId INT`);
        continue;
      }

      await qi.addColumn(actualTable, "erpConfigId", {
        type: DataTypes.INTEGER,
        allowNull: true,
      });
      changed += 1;
      console.log(`[ADDED] tenantId=${tenantId} db=${databaseName} table=${actualTable}: erpConfigId`);
    }
    return { checked: 1, changed, failed: 0 };
  } catch (error) {
    console.error(`[FAILED] tenantId=${tenantId} db=${databaseName}: ${error.message}`);
    return { checked: 1, changed, failed: 1 };
  } finally {
    if (connection && connection.sequelize) {
      await connection.sequelize.close().catch(() => {});
    }
  }
}

async function main() {
  let failed = false;
  const TenantDatabase = masterModels.TenantDatabase;
  const masterSequelize = masterModels.masterSequelize;
  await masterSequelize.authenticate();
  const rows = await TenantDatabase.findAll({
    where: { status: "READY" },
    attributes: ["tenantId", "databaseName", "status"],
    order: [["tenantId", "ASC"]],
  });

  console.log(`Master DB: ${process.env.MASTER_DB_NAME || "procur_master"}`);
  console.log(`READY tenant databases found: ${rows.length}`);
  console.log(`Mode: ${APPLY ? "APPLY (add missing nullable columns)" : "DRY RUN (no database changes)"}`);
  if (!rows.length) {
    console.log("No READY tenant database records found. Nothing to do.");
    return;
  }

  let checked = 0;
  let changed = 0;
  let failures = 0;
  for (const row of rows) {
    const result = await repairTenant(row);
    checked += result.checked;
    changed += result.changed;
    failures += result.failed;
  }

  console.log(`Summary: tenant DBs checked=${checked}, columns added=${changed}, failures=${failures}`);
  if (failures) failed = true;
  if (!APPLY) console.log("Dry run only. Re-run with --apply after reviewing the proposed changes.");
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Tenant ERP column repair aborted:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await masterModels.TenantDatabase.sequelize.close(); } catch (_) {}
  });
