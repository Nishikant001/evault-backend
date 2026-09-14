// src/config/masterConfig.js
//
// sequelize-cli config for the MASTER DB migrations, used via:
//   npm run migrate:master
//   npm run migrate:master:undo
//   npm run migrate:master:status
//
// Deliberately a .js file (unlike the legacy src/config/config.json) so it
// reads credentials from the environment instead of committing them to
// source control. Mirrors src/config/masterDatabase.js's fallback rule:
// only MASTER_DB_NAME is required to be distinct — host/user/password
// fall back to the existing DB_* vars if MASTER_DB_* aren't set.
require("dotenv").config();

const base = {
  username: process.env.MASTER_DB_USER || process.env.DB_USER,
  password: process.env.MASTER_DB_PASSWORD || process.env.DB_PASSWORD,
  database: process.env.MASTER_DB_NAME || "procur_master",
  host: process.env.MASTER_DB_HOST || process.env.DB_HOST,
  port: Number(process.env.MASTER_DB_PORT || process.env.DB_PORT || 3306),
  dialect: "mysql",
};

module.exports = {
  development: base,
  test: { ...base, database: `${base.database}_test` },
  production: base,
};
