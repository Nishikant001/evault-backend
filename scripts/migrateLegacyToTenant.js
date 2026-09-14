#!/usr/bin/env node
// scripts/migrateLegacyToTenant.js
//
// PHASE F — CLI entry point for the legacy-shared-DB -> tenant-DB data
// migration described in PHASE_F_MIGRATION_REPORT.md.
//
// Usage:
//   node scripts/migrateLegacyToTenant.js --dry-run --all-tenants
//   node scripts/migrateLegacyToTenant.js --dry-run --tenant=42
//   node scripts/migrateLegacyToTenant.js --tenant=42
//   node scripts/migrateLegacyToTenant.js --all-tenants
//   node scripts/migrateLegacyToTenant.js --tenant=42 --no-resume
//   node scripts/migrateLegacyToTenant.js --verify --tenant=42
//   node scripts/migrateLegacyToTenant.js --verify --all-tenants
//
// --tenant=<id> means the LEGACY tenant id (the id in the legacy shared
// `tenants` table — i.e. the id that Document.tenantId, User.tenantId
// etc. actually reference), never the master tenant id, since the
// legacy id is what the operator running this migration actually knows.
require("dotenv").config();
const { resolveEligibleTenants } = require("../src/database/legacyMigration/eligibleTenantResolver");
const { dryRunTenant, migrateTenant, verifyTenant } = require("../src/database/legacyMigration/legacyToTenantMigrator");
const {
  formatSkippedTenants,
  formatDryRunReport,
  formatMigrationResult,
  formatVerificationReport,
} = require("../src/database/legacyMigration/reportFormatter");

function parseArgs(argv) {
  const args = { dryRun: false, verify: false, allTenants: false, tenant: null, resume: true };
  for (const raw of argv) {
    if (raw === "--dry-run") args.dryRun = true;
    else if (raw === "--verify") args.verify = true;
    else if (raw === "--all-tenants") args.allTenants = true;
    else if (raw === "--no-resume") args.resume = false;
    else if (raw.startsWith("--tenant=")) args.tenant = Number(raw.split("=")[1]);
    else {
      console.error(`Unknown argument: ${raw}`);
      process.exit(1);
    }
  }
  if (!args.allTenants && !args.tenant) {
    console.error("Must pass either --all-tenants or --tenant=<legacyTenantId>");
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { eligible, skipped } = await resolveEligibleTenants({
    onlyLegacyTenantId: args.allTenants ? null : args.tenant,
  });

  console.log(formatSkippedTenants(skipped));

  if (eligible.length === 0) {
    console.log("\nNo eligible tenants to process (see skipped list above, if any).");
    return;
  }

  for (const tenant of eligible) {
    if (args.verify) {
      const report = await verifyTenant(tenant);
      console.log(formatVerificationReport(report));
    } else if (args.dryRun) {
      const report = await dryRunTenant(tenant);
      console.log(formatDryRunReport(report));
    } else {
      console.log(`\n>>> Migrating legacy tenant ${tenant.legacyTenantId} (${tenant.tenantName}) into ${tenant.databaseName} ...`);
      const result = await migrateTenant(tenant, { resume: args.resume });
      console.log(formatMigrationResult(result));
      console.log(`\n>>> Verifying legacy tenant ${tenant.legacyTenantId} ...`);
      const verification = await verifyTenant(tenant);
      console.log(formatVerificationReport(verification));
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nMigration script failed:", err);
    process.exit(1);
  });
