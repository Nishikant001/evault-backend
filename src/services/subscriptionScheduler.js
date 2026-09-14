// src/services/subscriptionScheduler.js
//
// Daily background job for the Subscription Management System, mirroring
// the sapSyncScheduler.js cron pattern (registered once from app.js after
// the Master DB connection is established).
//
// Runs once a day:
//   1. Sends reminder notifications for trials ending soon (T-7/T-3/T-1).
//   2. Expires any TRIAL subscription whose trialEndAt has passed
//      (via subscriptionService.expireDueTrials, which also writes
//      SubscriptionHistory).
//   3. Purges any FREE tenant whose trial has been EXPIRED past the
//      configured grace period (Task 5 — see tenantCleanupService.js).
//
// PHASE G (brief STEP 6): "Every tenant job must explicitly resolve
// Master DB -> Tenant -> TenantDatabase -> Tenant Sequelize. No
// background job may use the old shared DB." Subscription/Tenant are
// real Master DB models (src/models/masterDb, NOT the src/models/master.js
// compatibility shim, and NOT the legacy src/models). Per-tenant reads
// (the trial-reminder admin lookup, the in-app Notification) go through
// getTenantConnection(tenantId) — the same cached connection manager
// every HTTP request uses — never a static top-level model import.
//
// Manual trigger: runNow() lets an admin endpoint or a test invoke the
// same logic immediately, same "Run Now" convenience sapSyncScheduler
// offers for SAP jobs.

const cron = require("node-cron");
const masterModels = require("../models/masterDb");
const { getTenantConnection } = require("./tenantConnectionManager");
const SubscriptionService = require("./subscriptionService");
const NotificationService = require("./notificationService");
const NotificationCenterService = require("./notificationCenterService");
const TenantCleanupService = require("./tenantCleanupService"); // Task 5
const { SUBSCRIPTION_STATUS } = require("../constants/subscriptionConstants");

const REMINDER_DAYS = [7, 3, 1, 0];

// Task 5 — Trial Expiry Cleanup: number of days a FREE tenant's
// subscription must have already been EXPIRED before its data is
// permanently purged. 0 (default) = purge on the very next scheduler run
// after expiry. Raise via TRIAL_CLEANUP_GRACE_DAYS for a buffer window.
const CLEANUP_GRACE_DAYS = Number(process.env.TRIAL_CLEANUP_GRACE_DAYS || 0);

let task = null;

/** Resolves a tenant's own connection, or null if it isn't READY (e.g. mid-provisioning) — never falls back to a shared DB. */
async function tryGetTenantConnection(tenantId) {
  const tenantDb = await masterModels.TenantDatabase.findOne({ where: { tenantId } });
  if (!tenantDb || tenantDb.status !== "READY") return null;
  try {
    return await getTenantConnection(tenantId);
  } catch {
    return null;
  }
}

async function sendDueReminders() {
  const trials = await masterModels.Subscription.findAll({
    where: { status: SUBSCRIPTION_STATUS.TRIAL },
    include: [{ model: masterModels.Tenant }],
  });

  for (const subscription of trials) {
    const remaining = SubscriptionService.remainingTrialDays(subscription);
    if (remaining === null || !REMINDER_DAYS.includes(remaining)) continue;

    // Dedupe: don't re-send the same day's reminder twice.
    const lastSent = subscription.lastReminderSentAt;
    if (lastSent && new Date(lastSent).toDateString() === new Date().toDateString()) continue;

    const conn = await tryGetTenantConnection(subscription.tenantId);
    if (!conn) continue; // tenant DB not ready — skip this tenant this run, don't guess at a fallback

    const adminUser = await conn.models.User.findOne({
      where: { role: "TenantAdmin" },
    });

    await NotificationService.sendTrialReminder({
      email: adminUser?.email,
      mobileNumber: adminUser?.mobileNumber,
      tenantName: subscription.Tenant?.tenantName,
      remainingDays: remaining,
    });

    // Tenant-wide (userId=null) so every user of this FREE tenant sees the
    // banner on their dashboard/login, not just the admin.
    await NotificationCenterService.create(conn.models, {
      tenantId: subscription.tenantId,
      userId: null,
      type: remaining <= 0 ? "TRIAL_EXPIRED" : "TRIAL_REMINDER",
      title: remaining <= 0 ? "Trial expired" : `Trial ends in ${remaining} day(s)`,
      message:
        remaining <= 0
          ? "Your free trial has expired. Upgrade now to continue using all features."
          : `Your free trial ends in ${remaining} day(s). Upgrade now to avoid losing access.`,
    });

    subscription.lastReminderSentAt = new Date();
    await subscription.save();
  }
}

async function runNow() {
  // Order matters: sendDueReminders queries status=TRIAL, so the "expires
  // today" (remaining=0) reminder must fire before expireDueTrials flips
  // that same subscription to EXPIRED.
  await sendDueReminders();
  const expiredTenantIds = await SubscriptionService.expireDueTrials(masterModels);
  console.log(`🕒 [Subscription Scheduler] Run complete — ${expiredTenantIds.length} trial(s) expired`);

  // Task 5 — Trial Expiry Cleanup: purge any FREE tenant whose trial has
  // been EXPIRED for at least CLEANUP_GRACE_DAYS. Runs last, after this
  // run's own fresh EXPIRED flips are in place.
  const purgedTenantIds = await cleanupExpiredTrialTenants();

  return { expiredTenantIds, purgedTenantIds };
}

/**
 * Task 5 — finds every EXPIRED FREE-tenant subscription whose trialEndAt
 * is at least CLEANUP_GRACE_DAYS in the past, and hard-deletes that
 * tenant's entire data footprint via TenantCleanupService. One tenant's
 * failure is logged and skipped rather than aborting the whole batch.
 */
async function cleanupExpiredTrialTenants() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CLEANUP_GRACE_DAYS);

  const candidates = await masterModels.Subscription.findAll({
    where: { status: SUBSCRIPTION_STATUS.EXPIRED },
    include: [{ model: masterModels.Tenant }],
  });

  const purgedTenantIds = [];

  for (const subscription of candidates) {
    const tenant = subscription.Tenant;
    if (!tenant || String(tenant.tenantType).toUpperCase() !== "FREE") continue; // never touch PAID
    if (!subscription.trialEndAt || new Date(subscription.trialEndAt) > cutoff) continue; // still within grace window

    try {
      const result = await TenantCleanupService.purgeTenant(tenant.id);
      if (result.deleted) {
        purgedTenantIds.push(tenant.id);
        console.log(`🗑️  [Subscription Scheduler] Purged expired FREE tenant ${tenant.id} (${tenant.tenantCode})`);
      }
    } catch (error) {
      console.error(`❌ [Subscription Scheduler] Cleanup failed for tenant ${tenant.id}:`, error.message);
    }
  }

  return purgedTenantIds;
}

/** Registers the daily cron task. Idempotent — calling start() twice stops the previous task first. */
function start() {
  stop();
  const cronExpression = process.env.SUBSCRIPTION_SCHEDULER_CRON || "0 2 * * *"; // 02:00 daily
  if (!cron.validate(cronExpression)) {
    console.error(`❌ [Subscription Scheduler] Invalid cron "${cronExpression}" — task not registered`);
    return;
  }
  task = cron.schedule(cronExpression, async () => {
    try {
      await runNow();
    } catch (error) {
      console.error("❌ [Subscription Scheduler] Run failed:", error.message);
    }
  });
  console.log(`🕒 Subscription Scheduler started (${cronExpression})`);
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { start, stop, runNow, cleanupExpiredTrialTenants };
