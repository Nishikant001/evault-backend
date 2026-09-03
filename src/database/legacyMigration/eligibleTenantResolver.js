// src/database/legacyMigration/eligibleTenantResolver.js
//
// PHASE F — STEP 4 (brief): "Use MASTER DATABASE as the authoritative
// tenant registry... Never determine destination database only from a
// user-supplied value."
//
// This resolver NEVER invents a mapping. A legacy tenant is only
// eligible for migration when ALL of the following already exist,
// exactly as the brief's Step 4 example shows:
//   - a row in the LEGACY `tenants` table (source of the business data)
//   - a row in masterDb.Tenant, matched by the natural key `tenantCode`
//     (unique in both tables — verified in the audit, not assumed)
//   - a row in masterDb.TenantDatabase for that master tenantId, with
//     status = "READY" and a non-null databaseName
//
// Tenants that fail any of these checks are reported, never silently
// skipped — the brief requires a dry-run to show exactly this. Getting a
// legacy tenant into masterDb.Tenant + a READY TenantDatabase in the
// first place is tenant PROVISIONING (tenantProvisioningService.js /
// tenantController.js provision + retryProvisioning endpoints), which
// this phase explicitly must NOT recreate — see PHASE_F_MIGRATION_REPORT.md
// section "Out of scope: unprovisioned legacy tenants."
const legacyModels = require("../../models");
const masterModels = require("../../models/masterDb");

/**
 * @typedef {object} EligibleTenant
 * @property {number} legacyTenantId - id in the legacy `tenants` table (what Document.tenantId etc. actually reference)
 * @property {number} masterTenantId - id in masterDb.Tenant (== legacyTenantId's counterpart, may differ numerically)
 * @property {string} tenantCode
 * @property {string} tenantName
 * @property {string} databaseName - e.g. "tenant_42"
 */

/**
 * @returns {Promise<{ eligible: EligibleTenant[], skipped: Array<{legacyTenantId:number, tenantCode:string, tenantName:string, reason:string}> }>}
 */
async function resolveEligibleTenants({ onlyLegacyTenantId = null } = {}) {
  const legacyTenants = await legacyModels.Tenant.findAll({
    ...(onlyLegacyTenantId ? { where: { id: onlyLegacyTenantId } } : {}),
    raw: true,
  });

  const eligible = [];
  const skipped = [];

  for (const lt of legacyTenants) {
    const masterTenant = await masterModels.Tenant.findOne({ where: { tenantCode: lt.tenantCode }, raw: true });
    if (!masterTenant) {
      skipped.push({
        legacyTenantId: lt.id,
        tenantCode: lt.tenantCode,
        tenantName: lt.tenantName,
        reason: "NOT_PROVISIONED — no masterDb.Tenant row matches this legacy tenant's tenantCode. Provision it first via the existing tenant provisioning pipeline; this tool does not create tenants.",
      });
      continue;
    }

    const tenantDb = await masterModels.TenantDatabase.findOne({ where: { tenantId: masterTenant.id }, raw: true });
    if (!tenantDb) {
      skipped.push({
        legacyTenantId: lt.id,
        tenantCode: lt.tenantCode,
        tenantName: lt.tenantName,
        reason: `NOT_PROVISIONED — masterDb.Tenant id=${masterTenant.id} exists but has no TenantDatabase row.`,
      });
      continue;
    }
    if (tenantDb.status !== "READY" || !tenantDb.databaseName) {
      skipped.push({
        legacyTenantId: lt.id,
        tenantCode: lt.tenantCode,
        tenantName: lt.tenantName,
        reason: `NOT_READY — TenantDatabase status=${tenantDb.status}${tenantDb.databaseName ? "" : ", databaseName is null"}.`,
      });
      continue;
    }

    eligible.push({
      legacyTenantId: lt.id,
      masterTenantId: masterTenant.id,
      tenantCode: lt.tenantCode,
      tenantName: lt.tenantName,
      databaseName: tenantDb.databaseName,
    });
  }

  return { eligible, skipped };
}

module.exports = { resolveEligibleTenants };
