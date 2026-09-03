// src/models/masterDb/GlobalUserIndex.js
//
// PHASE D — new Master DB model, added specifically to keep the
// registration flow's existing "email/mobile already registered"
// business rule working under a real database-per-tenant architecture.
//
// WHY THIS EXISTS: before Phase D, User rows for every tenant lived in
// one shared database, so `User.findOne({ where: { email } })` could
// check global uniqueness directly. Once each tenant has its own
// physical database (Phase A/B/C), there is no single table to query
// for "does this email exist anywhere" — and the brief is explicit that
// normal tenant users must NOT be stored in the Master DB. This table
// is a deliberately minimal compromise: it stores just enough to answer
// "is this email/mobile taken, and by which tenant" — no password, no
// role, no other PII. It is populated once, when a tenant's admin user
// is actually created inside that tenant's own database (see
// tenantProvisioningService.js), and removed if provisioning
// subsequently fails (see the same file's failure-cleanup step).
//
// This also happens to be exactly the lookup Phase E's login flow will
// need (given only an email/password, which tenant database to check)
// — a natural side benefit, not scope creep for its own sake, but Phase
// E itself (wiring login through it) is NOT done here.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const GlobalUserIndex = masterSequelize.define(
  "GlobalUserIndex",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    mobileNumber: { type: DataTypes.STRING, allowNull: true, unique: true },
    tenantId: { type: DataTypes.INTEGER, allowNull: false },
    // The User.id inside that tenant's OWN database — not a Sequelize
    // association (that user row lives on a different physical
    // connection), just an integer reference for support/debug lookups.
    tenantUserId: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: "global_user_index",
    timestamps: true,
  },
);

module.exports = GlobalUserIndex;
