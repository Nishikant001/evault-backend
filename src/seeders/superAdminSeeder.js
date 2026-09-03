// PHASE G — DEAD CODE, NOT CALLED FROM PRODUCTION.
// This seeder targeted the legacy shared database (src/models). Since
// STEP 4/5 of PHASE_G_LEGACY_REMOVAL_REPORT.md, app.js boots against the
// Master DB only and calls scripts/seedMasterSuperAdmin.js instead (the
// real Master DB SuperAdmin model — src/models/masterDb/SuperAdmin.js).
// Retained on disk, unmodified, only because src/models/index.js (which
// it requires) is itself retained for src/database/legacyMigration/*
// tooling — see that report's "Files retained only for migration"
// section. Not wired into any route, controller, or app.js call.
const bcrypt = require("bcryptjs");

const {
  User,
  Tenant,
} = require("../models");

const seedSuperAdmin = async () => {

  try {

    let tenant =
    await Tenant.findOne({
      where: {
        tenantCode: "SYS001"
      }
    });

    if (!tenant) {

      tenant =
      await Tenant.create({
        tenantName: "System Tenant",
        tenantCode: "SYS001",
        status: "ACTIVE"
      });

      console.log(
        "System Tenant Created"
      );
    }

    const admin =
    await User.findOne({
      where: {
        email: process.env.SUPER_ADMIN_EMAIL
      }
    });

    if (admin) {

      console.log(
        "SuperAdmin Already Exists"
      );

      return;
    }

    const password =
    await bcrypt.hash(
      process.env.SUPER_ADMIN_PASSWORD,
      10
    );

    await User.create({

      name: "Super Admin",

      email:
      process.env.SUPER_ADMIN_EMAIL,

      password,

      role: "SuperAdmin",

tenantId: null,
      isActive: true

    });

    console.log(
      "SuperAdmin Created"
    );

  } catch (error) {

    console.log(
      "Seeder Error:",
      error.message
    );

  }
};

module.exports =
seedSuperAdmin;