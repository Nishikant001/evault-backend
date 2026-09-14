// scripts/seedMasterPlans.js
//
// PHASE D — one-off operational script (run once per environment, same
// spirit as `npm run migrate:master`): seeds the FREE/PAID Plan +
// PlanFeature catalog into the REAL Master DB (src/models/masterDb),
// as a prerequisite for POST /api/subscriptions/register/complete,
// which now creates Tenants/Subscriptions there instead of the legacy
// shared DB. Idempotent — safe to run more than once.
//
// Usage: node scripts/seedMasterPlans.js
// Also require()-able (e.g. from app.js boot) — see the require.main
// guard at the bottom, same pattern as scripts/seedMasterSuperAdmin.js.
require("dotenv").config();
const { Plan, PlanFeature, masterSequelize } = require("../src/models/masterDb");
const {
  PLAN_CODES,
  FREE_PLAN_FEATURES,
  PAID_PLAN_FEATURES,
  FREE_TRIAL_DURATION_DAYS,
} = require("../src/constants/subscriptionConstants");

async function ensurePlan(code, name, { isTrialable, trialDurationDays, features }) {
  let plan = await Plan.findOne({ where: { code } });
  if (!plan) {
    plan = await Plan.create({ code, name, isTrialable, trialDurationDays, isActive: true });
    console.log(`Plan created: ${code}`);
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

async function seedMasterPlans() {
  await ensurePlan(PLAN_CODES.FREE, "Free (Trial)", {
    isTrialable: true,
    trialDurationDays: FREE_TRIAL_DURATION_DAYS,
    features: FREE_PLAN_FEATURES,
  });
  await ensurePlan(PLAN_CODES.PAID, "Paid (Enterprise)", {
    isTrialable: false,
    trialDurationDays: null,
    features: PAID_PLAN_FEATURES,
  });
  console.log("Master DB plan catalog seeded.");
}

if (require.main === module) {
  seedMasterPlans()
    .then(() => masterSequelize.close())
    .catch((err) => {
      console.error("seedMasterPlans failed:", err);
      process.exitCode = 1;
    });
}

module.exports = seedMasterPlans;
