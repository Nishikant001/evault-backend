
require("dotenv").config();

const { Sequelize } = require("sequelize");
const masterSequelize = require("../src/config/masterDatabase");
const { TenantDatabase } = require("../src/models/masterDb");

const MIGRATION_NAME = "20261011000001-create-ocr-settings.js";

const MIGRATION = require(
  "../src/database/tenant/migrations/" + MIGRATION_NAME
);

async function main() {
  await masterSequelize.authenticate();
  console.log("Master DB connected");

  const tenants = await TenantDatabase.findAll({
    where: { status: "READY" },
    order: [["tenantId", "ASC"]],
  });

  console.log(`Found ${tenants.length} READY tenant databases.`);

  const summary = [];

  for (const tenant of tenants) {
    const dbName = tenant.databaseName;

    // Never create missing tenant databases or guess their names.
    if (!dbName || !/^tenant_[0-9]+$/.test(dbName)) {
      summary.push({
        tenantId: tenant.tenantId,
        database: dbName || "(missing)",
        result: "SKIPPED_UNSAFE_DATABASE_NAME",
      });
      continue;
    }

    const sequelize = new Sequelize(
      dbName,
      process.env.TENANT_DB_USER || process.env.MASTER_DB_USER,
      process.env.TENANT_DB_PASSWORD || process.env.MASTER_DB_PASSWORD,
      {
        host: process.env.TENANT_DB_HOST || process.env.MASTER_DB_HOST,
        port: process.env.TENANT_DB_PORT || process.env.MASTER_DB_PORT || 3306,
        dialect: "mysql",
        logging: false,
        pool: { max: 1, min: 0 },
      }
    );

    try {
      await sequelize.authenticate();

      const qi = sequelize.getQueryInterface();
      const tables = (await qi.showAllTables()).map((table) =>
        String(typeof table === "string" ? table : table.tableName)
          .toLowerCase()
      );

      if (!tables.includes("tenant_schema_migrations")) {
        throw new Error(
          "Migration history table missing; refusing automatic repair."
        );
      }

      const [history] = await sequelize.query(
        "SELECT name FROM tenant_schema_migrations WHERE name = :name",
        { replacements: { name: MIGRATION_NAME } }
      );

      if (tables.includes("ocr_settings")) {
        summary.push({
          tenantId: tenant.tenantId,
          database: dbName,
          result: history.length
            ? "ALREADY_PRESENT_AND_RECORDED"
            : "TABLE_PRESENT_BUT_UNRECORDED_REVIEW",
        });
        continue;
      }

      if (history.length) {
        throw new Error(
          "Migration is recorded but table is missing; refusing automatic repair."
        );
      }

      // Apply ONLY the OCR table migration.
      await MIGRATION.up(qi, Sequelize, sequelize);

      const updatedTables = (await qi.showAllTables()).map((table) =>
        String(typeof table === "string" ? table : table.tableName)
          .toLowerCase()
      );

      if (!updatedTables.includes("ocr_settings")) {
        throw new Error("Migration finished but table was not found.");
      }

      await sequelize.query(
        "INSERT INTO tenant_schema_migrations (name, appliedAt) VALUES (:name, :appliedAt)",
        {
          replacements: {
            name: MIGRATION_NAME,
            appliedAt: new Date(),
          },
        }
      );

      summary.push({
        tenantId: tenant.tenantId,
        database: dbName,
        result: "OCR_MIGRATION_APPLIED",
      });
    } catch (error) {
      console.error(
        `FAILED tenant ${tenant.tenantId} (${dbName}):`,
        error.message
      );
      summary.push({
        tenantId: tenant.tenantId,
        database: dbName,
        result: "FAILED",
        error: error.message,
      });
    } finally {
      await sequelize.close().catch(() => {});
    }
  }

  console.table(summary);
  await masterSequelize.close();

  if (summary.some((row) => row.result === "FAILED")) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error("Migration script failed:", error.message);
  await masterSequelize.close().catch(() => {});
  process.exitCode = 1;
});
