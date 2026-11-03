require("dotenv").config();

const { Sequelize } = require("sequelize");
const { runTenantMigrations } = require("../src/database/tenant/migrationRunner");

const databaseName = "tenant_2";

const sequelize = new Sequelize(
  databaseName,
  process.env.TENANT_DB_USER || process.env.MASTER_DB_USER,
  process.env.TENANT_DB_PASSWORD || process.env.MASTER_DB_PASSWORD,
  {
    host: process.env.TENANT_DB_HOST || process.env.MASTER_DB_HOST,
    port: Number(process.env.TENANT_DB_PORT || process.env.MASTER_DB_PORT || 3306),
    dialect: "mysql",
    logging: false,
  }
);

async function main() {
  try {
    await sequelize.authenticate();
    console.log(`Connected to ${databaseName}`);

    const result = await runTenantMigrations(sequelize, (event, detail) => {
      console.log(event, detail || "");
    });

    console.log("Applied migrations:", result.applied);
    console.log("Skipped migrations:", result.skipped);
  } finally {
    await sequelize.close();
  }
}

main().catch((error) => {
  console.error("Tenant migration failed:", error.message);
  process.exitCode = 1;
});
