// src/database/tenant/migrations/20260813000001-create-tenant-schema.js
//
// PHASE D — migration 0001, and (for now) the ONLY tenant migration:
// creates every one of the 34 tenant tables + their foreign keys, in one
// shot, straight from Phase B's defineTenantModels() factory.
//
// DELIBERATE DESIGN CHOICE, stated plainly rather than silently decided
// (this is the exact fork PHASE_C_REPORT.md flagged as open): this uses
// `sequelize.sync()` against the (correctly-ordered, association-aware)
// factory model set, NOT 34 separate hand-written createTable migration
// files. Trade-off, honestly:
//   + Genuinely correct schema (comes straight from the same model
//     definitions every controller/service already runs against — no
//     risk of a hand-copied migration drifting from the model).
//   + One file to maintain in lockstep with tenantModels/, not 34.
//   - NOT column-by-column incrementally alterable the way discrete
//     versioned migrations are — a future schema change needs an actual
//     new migration file (0002-...) that ALTERs, same as any migration
//     system; this file itself should not be edited after tenants exist.
// If per-model discrete migration files are later required (e.g. to
// match a specific ops/DBA workflow), each can be generated from the
// corresponding tenantModels/*.js file — flagged as remaining work in
// the Phase D final report rather than attempted here.
module.exports = {
  async up(queryInterface, Sequelize, sequelize) {
    const { defineTenantModels } = require("../../../models/tenantModels");
    // Rebinding the factory against THIS migration's sequelize connection
    // (not a shared/cached one) keeps this migration self-contained and
    // re-runnable in isolation (e.g. by a future standalone migration
    // CLI), independent of tenantConnectionManager's cache lifecycle.
    defineTenantModels(sequelize);
    await sequelize.sync();
  },

  async down(queryInterface) {
    // Tenant databases are dropped wholesale (or left for forensic
    // inspection) on deprovisioning — see brief section 17, "Do NOT
    // implement DROP DATABASE as a normal user operation." A `down` that
    // dropped 34 tables one-by-one inside a database that's about to be
    // discarded anyway isn't useful; intentionally a no-op.
  },
};
