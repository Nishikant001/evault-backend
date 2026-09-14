// src/services/otpService.js
//
// Generates, hashes, and verifies OTPs for FREE-tenant mobile registration
// and login. Delivery is delegated to notificationService (SMS channel) —
// this module never sends anything itself.
//
// Phase 5: OtpVerification is a MASTER-side model (it's read before any
// Tenant/User exists, so it can never be tenant-scoped). Every function
// below now takes `masterModels` as its first parameter instead of
// importing OtpVerification as a static singleton — same pattern already
// used for auditService/userAssignmentService, just against
// req.masterModels instead of req.models. Call sites: subscriptionController.js.

const crypto = require("crypto");
const NotificationService = require("./notificationService");

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

function generateNumericOtp() {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = 10 ** OTP_LENGTH - 1;
  return String(crypto.randomInt(min, max));
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

// How long after OTP verification Step 2 (complete-registration) may still
// consume it. Keeps a verified-but-abandoned OTP from being usable indefinitely.
const VERIFIED_WINDOW_MINUTES = 30;

class OtpService {
  // `email` is only used for purpose="REGISTRATION" (Task 2, Step 1: Phone +
  // Email together) — carried on the OTP row until Step 2 creates the Tenant/User.
  static async sendOtp(masterModels, mobileNumber, purpose = "REGISTRATION", email = null) {
    if (!masterModels) throw new Error("OtpService.sendOtp requires `masterModels` as its first argument");
    const { OtpVerification } = masterModels;
    const otp = generateNumericOtp();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await OtpVerification.create({ mobileNumber, email, otpHash, purpose, expiresAt });

    await NotificationService.sendSms(
      mobileNumber,
      `Your Excelligent verification code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`,
    );

    return { sent: true, expiresAt };
  }

  static async verifyOtp(masterModels, mobileNumber, otp, purpose = "REGISTRATION") {
    if (!masterModels) throw new Error("OtpService.verifyOtp requires `masterModels` as its first argument");
    const { OtpVerification } = masterModels;
    const record = await OtpVerification.findOne({
      where: { mobileNumber, purpose, verifiedAt: null },
      order: [["createdAt", "DESC"]],
    });

    if (!record) return { valid: false, reason: "No OTP request found" };
    if (record.attempts >= MAX_ATTEMPTS) return { valid: false, reason: "Too many attempts" };
    if (new Date(record.expiresAt) < new Date()) return { valid: false, reason: "OTP expired" };

    if (record.otpHash !== hashOtp(otp)) {
      record.attempts += 1;
      await record.save();
      return { valid: false, reason: "Incorrect OTP" };
    }

    record.verifiedAt = new Date();
    await record.save();
    return { valid: true, email: record.email };
  }

  /**
   * Task 2, Step 2 lookup: finds the most recent verified-but-not-yet-consumed
   * REGISTRATION OTP for this mobile number, within VERIFIED_WINDOW_MINUTES of
   * verification. Returns the {mobileNumber, email} pair captured at Step 1,
   * or null if there's nothing usable (never verified, expired window, or
   * already consumed by a completed registration).
   */
  static async getVerifiedRegistration(masterModels, mobileNumber) {
    if (!masterModels) throw new Error("OtpService.getVerifiedRegistration requires `masterModels` as its first argument");
    const { OtpVerification } = masterModels;
    const record = await OtpVerification.findOne({
      where: { mobileNumber, purpose: "REGISTRATION" },
      order: [["createdAt", "DESC"]],
    });

    if (!record || !record.verifiedAt) return null;

    const windowMs = VERIFIED_WINDOW_MINUTES * 60 * 1000;
    if (Date.now() - new Date(record.verifiedAt).getTime() > windowMs) return null;

    return { mobileNumber: record.mobileNumber, email: record.email, otpVerificationId: record.id };
  }
}

module.exports = OtpService;
