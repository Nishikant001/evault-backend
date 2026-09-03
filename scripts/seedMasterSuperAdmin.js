// scripts/seedMasterSuperAdmin.js
//
// PHASE E — seeds the real Master DB `super_admins` row. Also invoked
// automatically from app.js's boot sequence (alongside the existing
// legacy seedSuperAdmin()/seedPlans() calls) — additive, does not touch
// or remove the legacy seeder.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { SuperAdmin, masterSequelize } = require("../src/models/masterDb");

async function seedMasterSuperAdmin() {
  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("seedMasterSuperAdmin: SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD not set, skipping.");
    return;
  }

  const existing = await SuperAdmin.findOne({ where: { email } });
  if (existing) {
    console.log("Master SuperAdmin already exists.");
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await SuperAdmin.create({ name: "Super Admin", email, password: passwordHash, isActive: true });
  console.log("Master SuperAdmin created.");
}

if (require.main === module) {
  seedMasterSuperAdmin()
    .then(() => masterSequelize.close())
    .catch((err) => {
      console.error("seedMasterSuperAdmin failed:", err);
      process.exitCode = 1;
    });
}

module.exports = seedMasterSuperAdmin;
