// src/database/tenant/seeders/20260813000001-default-tenant-settings.js
//
// PHASE D — default per-tenant settings rows.
//
// ON "DEFAULT ROLES / DEFAULT PERMISSIONS" (brief section 6): audited
// the codebase first, per this project's own working style — there is
// NO Role or Permission table anywhere in this schema. Access control
// is a fixed ENUM column (`User.role`: SuperAdmin, TenantAdmin,
// BranchManager, DeptHead, Manager, Uploader, Viewer, Auditor,
// Approver — see tenantModels/User.js) baked into the application code
// (roleMiddleware.js), not database-backed rows. There is deliberately
// nothing to seed for "roles" or "permissions" here — inventing new
// Role/Permission tables to have something to seed would be scope creep
// this phase explicitly warns against ("do not guess", "do not rewrite
// unrelated modules"). If database-backed RBAC is wanted later, that's
// its own schema change, not a Phase D seeder.
//
// What DOES exist and IS seeded: the two genuine "one row per tenant,
// all-default" settings tables already in the schema — AISettings
// (AI Document Assistant config) and SapSyncSettings (SAP sync /
// document-import behavior, closest existing match to the brief's
// "document configuration").
module.exports = {
  async run(models, { tenantId }) {
    const { AISettings, SapSyncSettings } = models;

    await AISettings.findOrCreate({
      where: { tenantId },
      defaults: { tenantId }, // every other column already has a model-level default
    });

    await SapSyncSettings.findOrCreate({
      where: { tenantId },
      defaults: { tenantId },
    });
  },
};
