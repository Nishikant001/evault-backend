// src/config/database.js
//
// PHASE G — LEGACY SHARED-DATABASE CONNECTION. RETAINED FOR MIGRATION
// TOOLING ONLY. NOT USED BY THE PRODUCTION APPLICATION.
//
// Production (src/app.js) no longer requires this file, authenticates
// against it, or syncs it — it boots against the Master DB only
// (src/config/masterDatabase.js) and every tenant request is routed to
// its own physical database by tenantResolverMiddleware.js. Every
// controller/service that used to import this connection's models
// (src/models/index.js) directly has been converted to req.models /
// req.masterModels / getTenantConnection(tenantId) — see
// PHASE_G_LEGACY_REMOVAL_REPORT.md for the full file-by-file record.
//
// This file (and src/models/index.js) is kept ONLY because
// src/database/legacyMigration/* (the Phase F tool that copies existing
// legacy tenant data into each tenant's own physical database) still
// needs to READ from the legacy database as its source. Once every
// legacy tenant has been migrated and verified, this file and
// src/models/index.js can be deleted along with src/database/
// legacyMigration/ itself — see that report's Step 11/"Remaining risks."
//
// Do not add new imports of this file outside src/database/legacyMigration/
// or src/models/index.js's own model-definition files.
const { Sequelize } = require("sequelize");

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: "mysql", // postgres if using PostgreSQL
    logging: false,
  }
);

module.exports = sequelize;