// src/seeders/planSeeder.js
//
// PHASE G — DEAD CODE, NOT CALLED FROM PRODUCTION.
// This seeder targeted the legacy shared database (src/models). Since
// STEP 4/5 of PHASE_G_LEGACY_REMOVAL_REPORT.md, app.js boots against the
// Master DB only and calls scripts/seedMasterPlans.js instead (the real
// Master DB Plan/PlanFeature models — src/models/masterDb). Retained on
// disk, unmodified, only because src/models/index.js (which it requires)
// is itself retained for src/database/legacyMigration/* tooling — see
// that report's "Files retained only for migration" section. Not wired
// into any route, controller, or app.js call.
//
// Idempotent, safe to run on every boot (mirrors superAdminSeeder.js).
//
// 1. Ensures FREE and PAID Plan rows + their PlanFeature rows exist.
// 2. Backfills a Subscription row for every Tenant that doesn't have one
//    yet. Existing tenants (created before this feature) get
//    tenantType=PAID (the model default) and are backfilled here with
//    planId=PAID, status=ACTIVE — so subscriptionMiddleware never hits a
//    "no subscription" case for a pre-existing customer, and their
//    behavior is provably unchanged.
//
// Adding a future plan (Professional/Enterprise/Premium) means adding a
// block here (or, once planRoutes.js is live, doing it via the SuperAdmin
// API) — never touching subscriptionMiddleware.js or any controller.

const {
  Plan,
  PlanFeature,
  Tenant,
  Subscription,
} = require("../models");

const {
  PLAN_CODES,
  FREE_PLAN_FEATURES,
  PAID_PLAN_FEATURES,
  FREE_TRIAL_DURATION_DAYS,
  SUBSCRIPTION_STATUS,
} = require("../constants/subscriptionConstants");

async function ensurePlan(code, name, { isTrialable, trialDurationDays, features }) {
  let plan = await Plan.findOne({ where: { code } });

  if (!plan) {
    plan = await Plan.create({
      code,
      name,
      isTrialable,
      trialDurationDays,
      isActive: true,
    });
    console.log(`Plan Created: ${code}`);
  }

  const existing = await PlanFeature.findAll({ where: { planId: plan.id } });
  const existingKeys = new Set(existing.map((f) => f.featureKey));

  for (const featureKey of features) {
    if (!existingKeys.has(featureKey)) {
      await PlanFeature.create({ planId: plan.id, featureKey, enabled: true });
    }
  }

  return plan;
}

async function seedPlans() {
  try {
    const freePlan = await ensurePlan(PLAN_CODES.FREE, "Free (Trial)", {
      isTrialable: true,
      trialDurationDays: FREE_TRIAL_DURATION_DAYS,
      features: FREE_PLAN_FEATURES,
    });

    const paidPlan = await ensurePlan(PLAN_CODES.PAID, "Paid (Enterprise)", {
      isTrialable: false,
      trialDurationDays: null,
      features: PAID_PLAN_FEATURES,
    });

    // ── Backfill: every existing Tenant gets a Subscription row ──────
    const tenants = await Tenant.findAll();

    for (const tenant of tenants) {
      const already = await Subscription.findOne({ where: { tenantId: tenant.id } });
      if (already) continue;

      const isFree = tenant.tenantType === "FREE";

      await Subscription.create({
        tenantId: tenant.id,
        planId: isFree ? freePlan.id : paidPlan.id,
        status: isFree ? SUBSCRIPTION_STATUS.TRIAL : SUBSCRIPTION_STATUS.ACTIVE,
        trialStartAt: isFree ? new Date() : null,
        trialEndAt: isFree
          ? new Date(Date.now() + FREE_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000)
          : null,
        paymentStatus: isFree ? "NA" : "PAID",
      });

      console.log(`Subscription backfilled for tenant ${tenant.id} (${tenant.tenantType})`);
    }
  } catch (error) {
    console.log("Plan Seeder Error:", error.message);
  }
}

module.exports = seedPlans;
