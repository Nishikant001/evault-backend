// src/database/tenant/migrations/20260819000001-add-communication-tables.js
//
// MERGE — Internal Communication Module (1-to-1 chat + voice messages).
//
// Any BRAND NEW tenant provisioned after this merge already gets these 6
// tables for free: they were added to defineTenantModels() in
// src/models/tenantModels/index.js, and 20260813000001-create-tenant-schema.js
// (migration 0001) calls defineTenantModels()+sequelize.sync() for every
// new tenant, which will now include them automatically.
//
// This second migration exists ONLY for tenants that were already
// provisioned (and therefore already have migration 0001 marked applied
// in their own tenant_schema_migrations table, so it will never re-run
// for them) BEFORE this merge landed. Re-running the exact same
// defineTenantModels()+sync() call is safe here because sequelize.sync()
// (without `force`/`alter`) only CREATES tables that don't exist yet —
// it never touches the 34 tables that are already there. Net effect on
// an existing tenant DB: adds exactly the 6 new
// communication_* tables and nothing else.
//
// See scripts/migrateAllTenants.js to apply this (and any other pending
// tenant migration) across every already-provisioned tenant in one run.
module.exports = {
  async up(queryInterface, Sequelize, sequelize) {
    const { defineTenantModels } = require("../../../models/tenantModels");
    defineTenantModels(sequelize);
    await sequelize.sync();
  },

  async down(queryInterface) {
    // Communication history is real user data — same "no destructive
    // auto-down" stance as migration 0001. Drop manually if ever truly
    // required, outside of the migration runner.
  },
};
