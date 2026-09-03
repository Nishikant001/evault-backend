// src/models/masterDb/SuperAdmin.js
//
// PHASE E — real Master DB model for platform administrators.
//
// WHY THIS EXISTS: before this phase, "SuperAdmin" was just a row in the
// same legacy shared `User` table as every tenant's users (role=
// "SuperAdmin", tenantId=null), seeded by src/seeders/superAdminSeeder.js
// alongside a placeholder "System Tenant" it doesn't actually belong to.
// That made SuperAdmin identity dependent on the SAME database tenant
// data was migrating away from, and doesn't match the brief's own
// preferred architecture ("MASTER DB: super_admins ... TENANT DB: users").
// A SuperAdmin is platform-level, not scoped to any tenant, so it
// belongs in the Master DB, structurally separate from every tenant's
// own `users` table — not filtered out of a shared one by role.
//
// BACKWARD COMPATIBILITY: the legacy shared-DB SuperAdmin row is NOT
// deleted and superAdminSeeder.js is NOT removed — see
// PHASE_E_FINAL_REPORT.md section 3 for why (existing tokens/tooling
// that assume that row exists keep working). authController.login now
// checks THIS table first; the legacy row becomes inert once a real
// SuperAdmin row exists here, which app.js's boot sequence now seeds
// automatically (see scripts/seedMasterSuperAdmin.js).
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const SuperAdmin = masterSequelize.define(
  "SuperAdmin",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    password: { type: DataTypes.STRING, allowNull: false }, // bcrypt hash, same as tenant Users
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "super_admins",
    timestamps: true,
  },
);

module.exports = SuperAdmin;
