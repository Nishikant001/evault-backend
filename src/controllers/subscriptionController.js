// src/controllers/subscriptionController.js
//
// FREE-tenant self-registration + login. Completely separate from
// authController.js / authRoutes.js, which remain the unchanged PAID
// flow (admin-created users, email + password). The JWTs issued here use
// the exact same JwtService/shape, so every other authenticated route
// treats a FREE-issued token identically to a PAID one — only
// req.tenant.tenantType / req.subscription (loaded by
// subscriptionMiddleware) determine what's allowed.

const bcrypt = require("bcryptjs");
// PHASE G — login/getStatus/listSubscriptions now resolve entirely
// through Master DB (masterModels) + the calling tenant's own connection
// (getTenantConnection), same as authController.js — no more legacy
// shared-DB read anywhere in this file.
// PHASE D: OTP + Tenant + Subscription + the new GlobalUserIndex are all
// REAL Master DB models now (src/models/masterDb), not the Phase 5
// compatibility shim. This is the one call site Phase D explicitly asks
// to be repointed — registration is the thing being provisioned.
const masterModels = require("../models/masterDb");
const { getTenantConnection } = require("../services/tenantConnectionManager");
const { provisionTenant, TenantProvisioningError } = require("../services/tenantProvisioningService");
const JwtService = require("../services/jwtService");
const OtpService = require("../services/otpService");
const SubscriptionService = require("../services/subscriptionService");
const AuditService = require("../services/auditService");

function generateTenantCode(mobileNumber) {
  return `FREE-${mobileNumber.slice(-6)}-${Date.now().toString(36).toUpperCase()}`;
}

class SubscriptionController {
  // ── FREE Registration — Task 2 New Flow ─────────────────────────
  // Step 1: Phone Number + Email  →  Send OTP
  static async sendRegistrationOtp(req, res) {
    try {
      const { mobileNumber, email } = req.body;
      if (!mobileNumber || !email) {
        return res.status(400).json({ success: false, message: "mobileNumber and email are required" });
      }

      // PHASE D: with User rows now living inside per-tenant databases,
      // there is no single table to check "is this email/mobile taken
      // anywhere" — GlobalUserIndex (Master DB) is the deliberately
      // minimal index that exists specifically to answer this (see
      // src/models/masterDb/GlobalUserIndex.js for the full rationale).
      const { GlobalUserIndex } = masterModels;
      const [existingByMobile, existingByEmail] = await Promise.all([
        GlobalUserIndex.findOne({ where: { mobileNumber } }),
        GlobalUserIndex.findOne({ where: { email } }),
      ]);
      if (existingByMobile) {
        return res.status(400).json({ success: false, message: "Mobile number already registered" });
      }
      if (existingByEmail) {
        return res.status(400).json({ success: false, message: "Email address already registered" });
      }

      const result = await OtpService.sendOtp(masterModels, mobileNumber, "REGISTRATION", email);
      return res.status(200).json({ success: true, message: "OTP sent", expiresAt: result.expiresAt });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // Step 1 (continued): Verify OTP — only confirms the phone number; does
  // NOT create the tenant yet. Company Name / Owner Name / Password come in
  // Step 2 (completeRegistration).
  static async verifyRegistrationOtp(req, res) {
    try {
      const { mobileNumber, otp } = req.body;
      if (!mobileNumber || !otp) {
        return res.status(400).json({ success: false, message: "mobileNumber and otp are required" });
      }

      const verification = await OtpService.verifyOtp(masterModels, mobileNumber, otp, "REGISTRATION");
      if (!verification.valid) {
        return res.status(400).json({ success: false, message: verification.reason });
      }

      return res.status(200).json({
        success: true,
        message: "OTP verified. Proceed to complete registration.",
        mobileNumber,
        email: verification.email,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // Step 2: Owner Name + Company Name + Password + Confirm Password → Create Tenant.
  // Requires the mobile number to have a still-valid verified OTP from Step 1
  // (OtpService.getVerifiedRegistration) — the email is read back from that
  // record, never re-typed, so it can never drift from what was OTP-verified.
  //
  // PHASE D — this now does two genuinely different things in sequence,
  // not one flat insert:
  //   1. A real Master DB transaction that creates Tenant + TenantDatabase
  //      (status=PROVISIONING) + Subscription/SubscriptionHistory — cheap,
  //      fully transactional, easy to roll back if any of it fails.
  //   2. TenantProvisioningService.provisionTenant() — CREATE DATABASE,
  //      run tenant migrations/seeders, create the admin — which CANNOT
  //      be part of that transaction (brief section 11) and is tracked
  //      instead via TenantDatabase.status. If step 2 fails, step 1's
  //      rows are deliberately NOT rolled back: the Tenant now exists in
  //      a real FAILED state that POST /api/tenants/:id/retry-provisioning
  //      can resume, rather than vanishing and forcing the person to
  //      re-enter everything and re-verify OTP from scratch.
  static async completeRegistration(req, res) {
    const { Tenant: MasterTenant, TenantDatabase, GlobalUserIndex } = masterModels;
    const { masterSequelize } = require("../models/masterDb");
    const t = await masterSequelize.transaction();
    let tenant;
    try {
      const { mobileNumber, ownerName, companyName, password, confirmPassword } = req.body;
      if (!mobileNumber || !ownerName || !companyName || !password || !confirmPassword) {
        await t.rollback();
        return res.status(400).json({
          success: false,
          message: "mobileNumber, ownerName, companyName, password and confirmPassword are required",
        });
      }
      if (password !== confirmPassword) {
        await t.rollback();
        return res.status(400).json({ success: false, message: "Password and Confirm Password do not match" });
      }

      const verified = await OtpService.getVerifiedRegistration(masterModels, mobileNumber);
      if (!verified || !verified.email) {
        await t.rollback();
        return res.status(400).json({
          success: false,
          message: "Phone number is not verified, or verification has expired. Please verify OTP again.",
        });
      }

      const [existingByMobile, existingByEmail] = await Promise.all([
        GlobalUserIndex.findOne({ where: { mobileNumber }, transaction: t }),
        GlobalUserIndex.findOne({ where: { email: verified.email }, transaction: t }),
      ]);
      if (existingByMobile || existingByEmail) {
        await t.rollback();
        return res.status(400).json({ success: false, message: "Mobile number or email is already registered" });
      }

      tenant = await MasterTenant.create(
        {
          tenantName: companyName,
          tenantCode: generateTenantCode(mobileNumber),
          status: "ACTIVE",
          tenantType: "FREE",
        },
        { transaction: t },
      );

      await TenantDatabase.create({ tenantId: tenant.id, status: "PROVISIONING" }, { transaction: t });

      await SubscriptionService.createFreeTenantSubscription(masterModels, tenant, { performedBy: null, transaction: t });

      await t.commit();
    } catch (error) {
      await t.rollback();
      return res.status(500).json({ success: false, message: error.message });
    }

    // ── Master DB rows are committed. Tenant exists, but is unusable
    // (no physical database yet) until provisioning below succeeds. ──
    let provisionResult;
    try {
      const verified = await OtpService.getVerifiedRegistration(masterModels, req.body.mobileNumber);
      provisionResult = await provisionTenant(masterModels, tenant.id, {
        name: req.body.ownerName,
        email: verified.email,
        password: req.body.password,
        mobileNumber: req.body.mobileNumber,
      });
    } catch (error) {
      const isProvisioningError = error instanceof TenantProvisioningError;
      return res.status(502).json({
        success: false,
        message: isProvisioningError
          ? `Company and plan were registered, but setting up your workspace database failed (${error.step}). Please retry — nothing was lost.`
          : error.message,
        tenant: { id: tenant.id, tenantCode: tenant.tenantCode },
        retryable: true,
      });
    }

    const { admin } = provisionResult;

    // ── Tenant DB is READY. Issue the JWT and write the RefreshToken +
    // audit entry into the TENANT's OWN database (both are tenant-side
    // models per Phase B) — reached through the normal cached, status-
    // gated connection path now that TenantDatabase.status === READY. ──
    const { models: tenantModels } = await getTenantConnection(tenant.id);
    const accessToken = JwtService.generateAccessToken({ id: admin.id, role: "TenantAdmin", tenantId: tenant.id, email: admin.email });
    const refreshToken = JwtService.generateRefreshToken({ id: admin.id });
    await tenantModels.RefreshToken.create({
      userId: admin.id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    await AuditService.log({
      req,
      models: tenantModels,
      userId: admin.id,
      action: "TENANT_SELF_REGISTERED",
      module: "SUBSCRIPTION",
      newValue: { tenantCode: tenant.tenantCode, companyName: req.body.companyName, ownerName: req.body.ownerName, email: admin.email },
      status: "SUCCESS",
    });

    return res.status(201).json({
      success: true,
      accessToken,
      refreshToken,
      tenant: { id: tenant.id, tenantName: tenant.tenantName, tenantCode: tenant.tenantCode, tenantType: "FREE" },
      user: { id: admin.id, name: req.body.ownerName, email: admin.email },
    });
  }

  // ── FREE Login — Task 2: Email + Password only. Phone is registration/OTP-only. ──
  // PHASE G — this endpoint duplicates authController.login()'s tier-2
  // path (GlobalUserIndex -> tenant DB); kept working rather than removed
  // per this phase's "do not modify business functionality unnecessarily."
  // No legacy shared-DB read anymore — User/RefreshToken now resolve
  // through that tenant's own connection, same as authController.
  static async login(req, res) {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ success: false, message: "email and password are required" });
      }

      const indexEntry = await masterModels.GlobalUserIndex.findOne({ where: { email } });
      if (!indexEntry) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }

      const tenantDb = await masterModels.TenantDatabase.findOne({ where: { tenantId: indexEntry.tenantId } });
      if (!tenantDb || tenantDb.status !== "READY") {
        return res.status(503).json({ success: false, message: "Tenant workspace is not ready" });
      }
      let conn;
      try {
        conn = await getTenantConnection(indexEntry.tenantId);
      } catch (err) {
        if (err instanceof TenantProvisioningError) {
          return res.status(503).json({ success: false, message: err.message });
        }
        throw err;
      }

      const user = await conn.models.User.findByPk(indexEntry.tenantUserId);
      if (!user || !user.isActive) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }

      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }

      const accessToken = JwtService.generateAccessToken(user);
      const refreshToken = JwtService.generateRefreshToken(user);
      await conn.models.RefreshToken.create({
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      const subscription = await masterModels.Subscription.findOne({ where: { tenantId: user.tenantId } });
      const remainingTrialDays = SubscriptionService.remainingTrialDays(subscription);

      return res.status(200).json({
        success: true,
        accessToken,
        refreshToken,
        subscription: subscription && {
          status: subscription.status,
          remainingTrialDays,
          trialExpired: subscription.status === "EXPIRED",
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // ── Task 3: 30 Days Trial status (dashboard) ────────────────────
  // GET /api/subscriptions/status — any authenticated tenant user.
  // Returns Plan, Trial Remaining Days, Trial End Date, Status so the
  // dashboard can render "29 Days Remaining" etc. without recomputing
  // anything client-side (always derived server-side, live, from trialEndAt).
  static async getStatus(req, res) {
    try {
      const tenantId = req.user.tenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: "No tenant associated with this user" });
      }

      const subscription = await masterModels.Subscription.findOne({
        where: { tenantId },
        include: [{ model: masterModels.Plan }],
      });
      if (!subscription) {
        return res.status(404).json({ success: false, message: "No subscription found for this tenant" });
      }

      const remainingTrialDays = SubscriptionService.remainingTrialDays(subscription);

      return res.status(200).json({
        success: true,
        data: {
          plan: subscription.Plan
            ? { code: subscription.Plan.code, name: subscription.Plan.name }
            : null,
          status: subscription.status,
          trialStartDate: subscription.trialStartAt,
          trialEndDate: subscription.trialEndAt,
          trialRemainingDays: remainingTrialDays,
          paymentStatus: subscription.paymentStatus,
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // ── SuperAdmin plan management ──────────────────────────────────
  static async listSubscriptions(req, res) {
    try {
      const subscriptions = await masterModels.Subscription.findAll({
        include: [{ model: masterModels.Tenant }, { model: masterModels.Plan }],
      });
      return res.status(200).json({ success: true, data: subscriptions });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async upgrade(req, res) {
    try {
      const { tenantId } = req.params;
      const { planCode, reason } = req.body;
      const result = await SubscriptionService.upgradePlan(masterModels, req.models, tenantId, planCode, {
        performedBy: req.user.id,
        reason,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async downgrade(req, res) {
    try {
      const { tenantId } = req.params;
      const { planCode, reason } = req.body;
      const result = await SubscriptionService.downgradePlan(masterModels, req.models, tenantId, planCode, {
        performedBy: req.user.id,
        reason,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async extendTrial(req, res) {
    try {
      const { tenantId } = req.params;
      const { days, reason } = req.body;
      const result = await SubscriptionService.extendTrial(masterModels, tenantId, Number(days), {
        performedBy: req.user.id,
        reason,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async deactivateTrial(req, res) {
    try {
      const { tenantId } = req.params;
      const { reason } = req.body;
      const result = await SubscriptionService.deactivateTrial(masterModels, tenantId, {
        performedBy: req.user.id,
        reason,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async convertToPaid(req, res) {
    try {
      const { tenantId } = req.params;
      const { reason } = req.body;
      const result = await SubscriptionService.convertFreeToPaid(masterModels, req.models, tenantId, {
        performedBy: req.user.id,
        reason,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = SubscriptionController;
