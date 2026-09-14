// src/config/masterDatabase.js
//
// PHASE A — REAL MASTER DB FOUNDATION.
//
// This is a genuinely SEPARATE Sequelize connection from the one in
// src/config/database.js. It talks to its own physical MySQL database
// (MASTER_DB_NAME), independent of any tenant database.
//
// Until Phase E (Tenant Resolver / Auth) rewires authMiddleware.js and
// src/models/master.js to use this connection, nothing in the running
// app points at this file yet — it is deliberately additive/standalone
// so it can be built and tested (connection + migrations + models) in
// isolation without touching any currently-working request path.
//
// Falls back to the same host/user/password as the legacy DB_* vars if
// the MASTER_DB_* vars aren't set, so a fresh clone doesn't need brand
// new MySQL credentials to try this out locally — only a distinct
// database NAME is required (see MASTER_DB_NAME below), since the whole
// point is a separate physical database, not just separate credentials.
const { Sequelize } = require("sequelize");

const masterSequelize = new Sequelize(
  process.env.MASTER_DB_NAME || "procur_master",
  process.env.MASTER_DB_USER || process.env.DB_USER,
  process.env.MASTER_DB_PASSWORD || process.env.DB_PASSWORD,
  {
    host: process.env.MASTER_DB_HOST || process.env.DB_HOST,
    port: process.env.MASTER_DB_PORT || process.env.DB_PORT || 3306,
    dialect: "mysql",
    logging: false,
  },
);

module.exports = masterSequelize;
