// src/services/subscriptionService.js
//
// Single place that mutates Subscription rows. Every mutation writes a
// SubscriptionHistory entry, mirroring the AuditLog pattern used
// elsewhere in this codebase. Controllers and the scheduler should call
// this service rather than touching Subscription/SubscriptionHistory
// directly.
//
// Phase 5: Subscription/SubscriptionHistory/Plan/Tenant are MASTER-side
// models. Every function below now takes `masterModels` as its first
// parameter instead of a static import (same pattern as otpService.js).
// The one write that touches TENANT data — the in-app Notification via
// NotificationCenterService.create() — takes a separate `tenantModels`
// parameter. In THIS codebase (no real per-tenant DB split yet — see
// src/models/master.js) both resolve to the same underlying connection,
// so callers may pass the same object for both; the split is kept so the
// call is already correctly shaped for when genuine per-tenant databases
// exist (pass req.masterModels + req.models respectively).

const NotificationCenterService = require("./notificationCenterService");

const {
  PLAN_CODES,
  SUBSCRIPTION_STATUS,
  FREE_TRIAL_DURATION_DAYS,
} = require("../constants/subscriptionConstants");

class SubscriptionService {
  /** Creates Tenant + Subscription (TRIAL) for a brand-new FREE registration. Caller creates the User. */
static async createFreeTenantSubscription(
    masterModels,
    tenant,
    {
        performedBy = null,
        transaction = null
    } = {}
) {
    if (!masterModels) throw new Error("SubscriptionService.createFreeTenantSubscription requires `masterModels`");
    const { Plan, Subscription, SubscriptionHistory } = masterModels;

    const freePlan = await Plan.findOne({
        where: { code: PLAN_CODES.FREE },
        transaction
    });

    if (!freePlan)
        throw new Error("FREE plan is not seeded");

    const now = new Date();

    const trialEndAt = new Date(
        now.getTime() +
        FREE_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
    );

    const subscription = await Subscription.create({
        tenantId: tenant.id,
        planId: freePlan.id,
        status: SUBSCRIPTION_STATUS.TRIAL,
        trialStartAt: now,
        trialEndAt,
        paymentStatus: "NA"
    }, {
        transaction
    });

    await SubscriptionHistory.create({
        tenantId: tenant.id,
        fromPlanId: null,
        toPlanId: freePlan.id,
        action: "CREATED",
        performedBy,
        reason: "FREE self-registration"
    }, {
        transaction
    });

    return subscription;
}

  static async getForTenant(masterModels, tenantId) {
    if (!masterModels) throw new Error("SubscriptionService.getForTenant requires `masterModels`");
    const { Plan, Subscription } = masterModels;
    return Subscription.findOne({ where: { tenantId }, include: [{ model: Plan }] });
  }

  /** Derives remaining trial days, never negative. */
  static remainingTrialDays(subscription) {
    if (!subscription || !subscription.trialEndAt) return null;
    const diffMs = new Date(subscription.trialEndAt).getTime() - Date.now();
    return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
  }

  static async extendTrial(masterModels, tenantId, extraDays, { performedBy = null, reason = null } = {}) {
    if (!masterModels) throw new Error("SubscriptionService.extendTrial requires `masterModels`");
    const { Subscription, SubscriptionHistory } = masterModels;
    const subscription = await Subscription.findOne({ where: { tenantId } });
    if (!subscription) throw new Error("Subscription not found");

    const base = subscription.trialEndAt && subscription.trialEndAt > new Date()
      ? new Date(subscription.trialEndAt)
      : new Date();
    base.setDate(base.getDate() + extraDays);

    subscription.trialEndAt = base;
    subscription.status = SUBSCRIPTION_STATUS.TRIAL;
    await subscription.save();

    await SubscriptionHistory.create({
      tenantId,
      fromPlanId: subscription.planId,
      toPlanId: subscription.planId,
      action: "TRIAL_EXTENDED",
      performedBy,
      reason,
    });

    return subscription;
  }

  static async deactivateTrial(masterModels, tenantId, { performedBy = null, reason = null } = {}) {
    if (!masterModels) throw new Error("SubscriptionService.deactivateTrial requires `masterModels`");
    const { Subscription, SubscriptionHistory } = masterModels;
    const subscription = await Subscription.findOne({ where: { tenantId } });
    if (!subscription) throw new Error("Subscription not found");

    subscription.status = SUBSCRIPTION_STATUS.SUSPENDED;
    await subscription.save();

    await SubscriptionHistory.create({
      tenantId,
      fromPlanId: subscription.planId,
      toPlanId: subscription.planId,
      action: "TRIAL_DEACTIVATED",
      performedBy,
      reason,
    });

    return subscription;
  }

  /** Converts a FREE tenant to PAID. Flips Tenant.tenantType too, so watermark/SAP gating changes immediately. */
  static async convertFreeToPaid(masterModels, tenantModels, tenantId, { performedBy = null, reason = null } = {}) {
    if (!masterModels) throw new Error("SubscriptionService.convertFreeToPaid requires `masterModels`");
    const { Tenant, Subscription, SubscriptionHistory, Plan } = masterModels;
    const [tenant, subscription, paidPlan] = await Promise.all([
      Tenant.findByPk(tenantId),
      Subscription.findOne({ where: { tenantId } }),
      Plan.findOne({ where: { code: PLAN_CODES.PAID } }),
    ]);
    if (!tenant || !subscription || !paidPlan) throw new Error("Tenant/Subscription/PAID plan not found");

    const fromPlanId = subscription.planId;

    tenant.tenantType = "PAID";
    await tenant.save();

    subscription.planId = paidPlan.id;
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.paymentStatus = "PAID";
    subscription.trialEndAt = subscription.trialEndAt; // preserved for history/reference only
    await subscription.save();

    await SubscriptionHistory.create({
      tenantId,
      fromPlanId,
      toPlanId: paidPlan.id,
      action: "CONVERTED_FREE_TO_PAID",
      performedBy,
      reason,
    });

    await NotificationCenterService.create(tenantModels || masterModels, {
      tenantId,
      userId: null,
      type: "SUBSCRIPTION_CHANGED",
      title: "Welcome to Paid!",
      message: "Your account has been upgraded to a Paid plan. All features, including SAP sync and AI Assistant, are now unlocked.",
    });

    return subscription;
  }

  static async upgradePlan(masterModels, tenantModels, tenantId, newPlanCode, { performedBy = null, reason = null } = {}) {
    if (!masterModels) throw new Error("SubscriptionService.upgradePlan requires `masterModels`");
    const { Subscription, SubscriptionHistory, Plan } = masterModels;
    const [subscription, newPlan] = await Promise.all([
      Subscription.findOne({ where: { tenantId } }),
      Plan.findOne({ where: { code: newPlanCode } }),
    ]);
    if (!subscription || !newPlan) throw new Error("Subscription or target plan not found");

    const fromPlanId = subscription.planId;
    subscription.planId = newPlan.id;
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    await subscription.save();

    await SubscriptionHistory.create({
      tenantId,
      fromPlanId,
      toPlanId: newPlan.id,
      action: "UPGRADE",
      performedBy,
      reason,
    });

    await NotificationCenterService.create(tenantModels || masterModels, {
      tenantId,
      userId: null,
      type: "SUBSCRIPTION_CHANGED",
      title: "Plan upgraded",
      message: `Your subscription has been upgraded to ${newPlan.name}.`,
    });

    return subscription;
  }

  static async downgradePlan(masterModels, tenantModels, tenantId, newPlanCode, opts = {}) {
    if (!masterModels) throw new Error("SubscriptionService.downgradePlan requires `masterModels`");
    const { SubscriptionHistory } = masterModels;
    // Same mechanics as upgrade — direction is just an audit-trail label.
    const result = await this.upgradePlan(masterModels, tenantModels, tenantId, newPlanCode, opts);
    await SubscriptionHistory.create({
      tenantId,
      fromPlanId: result.planId,
      toPlanId: result.planId,
      action: "DOWNGRADE",
      performedBy: opts.performedBy || null,
      reason: opts.reason || null,
    });
    return result;
  }

  /** Called by subscriptionScheduler daily. Marks due trials EXPIRED. Returns the tenants that were just expired. */
  static async expireDueTrials(masterModels) {
    if (!masterModels) throw new Error("SubscriptionService.expireDueTrials requires `masterModels`");
    const { Subscription, SubscriptionHistory } = masterModels;
    const due = await Subscription.findAll({
      where: { status: SUBSCRIPTION_STATUS.TRIAL },
    });

    const expiredTenantIds = [];
    const now = new Date();

    for (const subscription of due) {
      if (subscription.trialEndAt && new Date(subscription.trialEndAt) <= now) {
        subscription.status = SUBSCRIPTION_STATUS.EXPIRED;
        await subscription.save();

        await SubscriptionHistory.create({
          tenantId: subscription.tenantId,
          fromPlanId: subscription.planId,
          toPlanId: subscription.planId,
          action: "EXPIRED",
          performedBy: null,
          reason: "Trial period ended",
        });

        expiredTenantIds.push(subscription.tenantId);
      }
    }

    return expiredTenantIds;
  }
}

module.exports = SubscriptionService;
