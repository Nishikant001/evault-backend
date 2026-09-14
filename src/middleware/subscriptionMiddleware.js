// src/middleware/subscriptionMiddleware.js
//
// Enterprise subscription/feature guards. Follows the same factory
// pattern as roleMiddleware.js / accessControlMiddleware.js. Never
// scatter plan checks in controllers — every gate lives here.
//
// Order in a route: auth, loadSubscription, requireActiveSubscription?,
// requireFeature(...)/requireSAP/requireAI/requirePaidPlan, role(...).
//
// SuperAdmin (platform-level, tenantId === null) bypasses every guard
// here, exactly like authMiddleware already does for tenant status.
//
// Phase 5: Tenant/Subscription/Plan/PlanFeature are MASTER-side models;
// Document is a TENANT-side model. This middleware always runs AFTER
// authMiddleware (which populates req.models / req.masterModels on every
// authenticated request), so both are read from req rather than a static
// top-of-file import — no more `require("../models")` singleton here.

const { Op } = require("sequelize");
const {
  SUBSCRIPTION_STATUS,
  FEATURE_KEYS,
  FREE_DAILY_UPLOAD_LIMIT,
} = require("../constants/subscriptionConstants");

/** Loads req.tenant, req.subscription, req.planFeatures (Set<featureKey>) once per request. */
const loadSubscription = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // Platform SuperAdmin has no tenant — nothing to load or gate.
    if (req.user.role === "SuperAdmin" && !req.user.tenantId) {
      req.tenant = null;
      req.subscription = null;
      req.planFeatures = null;
      return next();
    }

    if (!req.masterModels) {
      return res.status(500).json({
        success: false,
        message: "Subscription check unavailable: req.masterModels not populated (authMiddleware must run first)",
      });
    }
    const { Tenant, Subscription, Plan, PlanFeature } = req.masterModels;

    // authMiddleware already loaded and validated this tenant (status ACTIVE) —
    // reuse it instead of a second query; fall back to a fresh lookup if the
    // route somehow reached here without authMiddleware running first.
    const tenant = req.tenant || (await Tenant.findByPk(req.user.tenantId));
    if (!tenant) {
      return res.status(403).json({ success: false, message: "Tenant not found" });
    }

    const subscription = await Subscription.findOne({
      where: { tenantId: tenant.id },
      include: [{ model: Plan, include: [{ model: PlanFeature, as: "features" }] }],
    });

    if (!subscription) {
      return res.status(403).json({
        success: false,
        message: "No active subscription found for this tenant",
      });
    }

    const planFeatures = new Set(
      (subscription.Plan?.features || [])
        .filter((f) => f.enabled)
        .map((f) => f.featureKey),
    );

    req.tenant = tenant;
    req.subscription = subscription;
    req.planFeatures = planFeatures;

    return next();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** Blocks the request once a subscription has expired — every login/API call should see this, not just the UI. */
const requireActiveSubscription = () => {
  return (req, res, next) => {
    if (!req.subscription) return next(); // SuperAdmin / not yet loaded

    if (req.subscription.status === SUBSCRIPTION_STATUS.EXPIRED) {
      return res.status(402).json({
        success: false,
        code: "TRIAL_EXPIRED",
        message: "Your trial has expired. Please upgrade to continue.",
      });
    }
    if (req.subscription.status === SUBSCRIPTION_STATUS.SUSPENDED) {
      return res.status(403).json({
        success: false,
        code: "SUBSCRIPTION_SUSPENDED",
        message: "Your subscription has been suspended. Contact support.",
      });
    }
    return next();
  };
};

/** Generic feature-flag gate. Use this for anything not already covered by requireSAP/requireAI/requirePaidPlan. */
const requireFeature = (featureKey) => {
  return (req, res, next) => {
    if (!req.planFeatures) return next(); // SuperAdmin

    if (!req.planFeatures.has(featureKey)) {
      return res.status(403).json({
        success: false,
        code: "FEATURE_NOT_AVAILABLE",
        feature: featureKey,
        message: `This feature (${featureKey}) is not available on your current plan.`,
      });
    }
    return next();
  };
};

const requireSAP = requireFeature(FEATURE_KEYS.SAP_SYNC);
const requireAI = requireFeature(FEATURE_KEYS.AI_ASSISTANT);

/**
 * Task 4 — Daily Upload Limit: FREE tenants may upload at most
 * FREE_DAILY_UPLOAD_LIMIT documents per calendar day (UTC). PAID tenants
 * are never gated here. Count is read straight from the `documents` table
 * (createdAt), NOT an in-memory counter, so it survives restarts/multiple
 * app instances and resets itself automatically at UTC midnight — no
 * scheduled reset job needed.
 *
 * Place this AFTER loadSubscription in the route chain (needs req.tenant).
 */
const enforceDailyUploadLimit = () => {
  return async (req, res, next) => {
    try {
      // SuperAdmin / no tenant loaded, or PAID tenant — unlimited, same as today.
      if (!req.tenant || String(req.tenant.tenantType).toUpperCase() !== "FREE") {
        return next();
      }

      if (!req.models) {
        return res.status(500).json({
          success: false,
          message: "Upload limit check unavailable: req.models not populated (authMiddleware must run first)",
        });
      }
      const { Document } = req.models;

      const startOfDayUTC = new Date();
      startOfDayUTC.setUTCHours(0, 0, 0, 0);

      const todaysUploadCount = await Document.count({
        where: {
          tenantId: req.tenant.id,
          createdAt: { [Op.gte]: startOfDayUTC },
        },
      });

      if (todaysUploadCount >= FREE_DAILY_UPLOAD_LIMIT) {
        return res.status(429).json({
          success: false,
          message: "Daily upload limit exceeded. Please try again after 24 hours.",
        });
      }

      return next();
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  };
};

/** For the handful of rules that are plan-type, not feature-flag (e.g. "no watermark"). */
const requirePaidPlan = () => {
  return (req, res, next) => {
    if (!req.tenant) return next(); // SuperAdmin

    if (req.tenant.tenantType !== "PAID") {
      return res.status(403).json({
        success: false,
        code: "PAID_PLAN_REQUIRED",
        message: "This action is available on paid plans only.",
      });
    }
    return next();
  };
};

/**
 * Task 6 — Subscription Middleware: single composed gate for routes that
 * want everything checked in one call instead of chaining the individual
 * middlewares above. Internally reuses loadSubscription /
 * requireActiveSubscription / enforceDailyUploadLimit — no duplicated
 * logic, just orchestration, per Task 7 (reuse existing pieces).
 *
 * Verifies, in order:
 *   1. Tenant is loaded and ACTIVE (loadSubscription -> authMiddleware already
 *      rejects INACTIVE tenants; this is the subscription-level check)
 *   2. Plan/Subscription exists for the tenant
 *   3. Subscription status is not EXPIRED / SUSPENDED (requireActiveSubscription)
 *   4. Trial expiry (covered by the same status check — a subscription whose
 *      trialEndAt has passed is flipped to EXPIRED by subscriptionScheduler)
 *   5. Daily upload limit, only when options.checkUploadLimit is true
 *
 * Usage: router.post('/upload', auth, checkSubscription({ checkUploadLimit: true }), role(...), upload.single('file'), uploadDocument)
 */
const checkSubscription = (options = {}) => {
  const { checkUploadLimit = false } = options;

  return async (req, res, next) => {
    // 1-2. Load tenant/subscription/plan features if not already loaded upstream.
    if (req.subscription === undefined) {
      return loadSubscription(req, res, async (err) => {
        if (err) return next(err); // loadSubscription already sent a response on failure
        return runGates();
      });
    }
    return runGates();

    async function runGates() {
      // Inactive tenant is already blocked by authMiddleware before this
      // point ever runs; guard again defensively for direct middleware use.
      if (req.tenant && req.tenant.status && req.tenant.status !== "ACTIVE") {
        return res.status(403).json({
          success: false,
          code: "TENANT_INACTIVE",
          message: "This tenant account is inactive. Contact support.",
        });
      }

      return requireActiveSubscription()(req, res, () => {
        if (!checkUploadLimit) return next();
        return enforceDailyUploadLimit()(req, res, next);
      });
    }
  };
};

module.exports = {
  loadSubscription,
  requireActiveSubscription,
  requireFeature,
  requireSAP,
  requireAI,
  requirePaidPlan,
  enforceDailyUploadLimit,
  checkSubscription,
};
