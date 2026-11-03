require("dotenv").config();

const { Sequelize } = require("sequelize");
const { runTenantMigrations } = require("../src/database/tenant/migrationRunner");

const database = "tenant_2";

const user =
  process.env.TENANT_DB_USER ||
  process.env.MASTER_DB_USER ||
  process.env.DB_USER;

const password =
  process.env.TENANT_DB_PASSWORD ||
  process.env.MASTER_DB_PASSWORD ||
  process.env.DB_PASSWORD;

const host =
  process.env.TENANT_DB_HOST ||
  process.env.MASTER_DB_HOST ||
  process.env.DB_HOST;

const port = Number(
  process.env.TENANT_DB_PORT ||
  process.env.MASTER_DB_PORT ||
  process.env.DB_PORT ||
  3306
);

if (!user || !password || !host) {
  console.error("ERROR: Tenant database configuration is incomplete.");
  process.exit(1);
}

const sequelize = new Sequelize(database, user, password, {
  host,
  port,
  dialect: "mysql",
  logging: false,
});

async function main() {
  try {
    await sequelize.authenticate();
    console.log(`Connected to ${database}`);

    const result = await runTenantMigrations(sequelize, (event, detail) => {
      console.log(`[MIGRATION] ${event}`, detail || "");
    });

    console.log("\n===== MIGRATION RESULT =====");
    console.log("Applied:", result.applied);
    console.log("Skipped:", result.skipped);
    console.log("Migration run completed.");
  } finally {
    await sequelize.close();
  }
}

main().catch((error) => {
  console.error("MIGRATION FAILED:", error.message);
  process.exitCode = 1;
});
