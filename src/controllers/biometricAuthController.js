// src/controllers/biometricAuthController.js
//
// Fingerprint ("biometric") login for the mobile app.
//
// How it works (no fingerprint data ever reaches the server):
//   1. User logs in normally, then enables fingerprint login (enroll, needs the
//      password again). Server creates a random secret, stores ONLY its SHA-256
//      hash, and returns a one-time "device token" = "<tenantId>.<deviceId>.<secret>".
//   2. The phone keeps that token in the OS keystore behind the biometric prompt.
//   3. Later the phone unlocks the token with the fingerprint and calls
//      POST /api/auth/biometric/login. The server verifies the hash, re-checks
//      user/tenant/role from the DATABASE and issues normal access + refresh
//      tokens - the same ones /api/auth/login issues.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const masterModels = require("../models/masterDb");
const { getTenantConnection, TenantProvisioningError } = require("../services/tenantConnectionManager");
const JwtService = require("../services/jwtService");
const AuditService = require("../services/auditService");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEVICE_TTL_DAYS = Number(process.env.BIOMETRIC_DEVICE_TTL_DAYS || 90);
const MAX_ACTIVE_DEVICES_PER_USER = 5;

const GENERIC_FAIL = {
  success: false,
  message: "Biometric login failed. Please sign in with your password.",
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function safeEqualHex(a, b) {
  const A = Buffer.from(String(a), "hex");
  const B = Buffer.from(String(b), "hex");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Token format: "<tenantId>.<deviceId>.<secret>". tenantId is ONLY used to pick
// which tenant database to look in; a forged tenantId just finds no matching row.
function parseDeviceToken(raw) {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [t, deviceId, secret] = parts;
  const tenantId = Number(t);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return null;
  if (!/^[0-9a-f-]{36}$/i.test(deviceId)) return null;
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(secret)) return null;
  return { tenantId, deviceId: deviceId.toLowerCase(), secret };
}

class BiometricAuthController {
  // POST /api/auth/biometric/enroll   (authMiddleware)
  // body: { password, deviceLabel?, platform? }
  static async enroll(req, res) {
    try {
      if (!req.models) {
        return res.status(403).json({ success: false, message: "Biometric login is not available for this account." });
      }
      const { User, BiometricDevice } = req.models;
      const { password, deviceLabel, platform } = req.body || {};
      if (typeof password !== "string" || !password) {
        return res.status(400).json({ success: false, message: "password is required" });
      }

      const user = await User.findByPk(req.user.id);
      if (!user || !user.isActive) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        await AuditService.log({
          req, action: "BIOMETRIC_ENROLL_FAILED", module: "AUTH", status: "FAILED",
          remarks: `Biometric enrollment rejected for ${user.email}: wrong password`,
        });
        return res.status(401).json({ success: false, message: "Invalid Credentials" });
      }

      // Keep at most MAX_ACTIVE_DEVICES_PER_USER active devices (oldest are revoked first).
      const active = await BiometricDevice.findAll({
        where: { userId: user.id, revokedAt: null },
        order: [["createdAt", "ASC"]],
      });
      const overflow = active.length - (MAX_ACTIVE_DEVICES_PER_USER - 1);
      if (overflow > 0) {
        for (const d of active.slice(0, overflow)) {
          await d.update({ revokedAt: new Date(), revokedReason: "SUPERSEDED" });
        }
      }

      const deviceId = crypto.randomUUID();
      const secret = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + DEVICE_TTL_DAYS * DAY_MS);

      await BiometricDevice.create({
        userId: user.id,
        deviceId,
        secretHash: sha256(secret),
        deviceLabel: typeof deviceLabel === "string" ? deviceLabel.slice(0, 120) : null,
        platform: typeof platform === "string" ? platform.slice(0, 20) : null,
        expiresAt,
      });

      await AuditService.log({
        req, action: "BIOMETRIC_ENROLLED", module: "AUTH", status: "SUCCESS",
        remarks: `Biometric login enabled for ${user.email}`,
      });

      return res.status(201).json({
        success: true,
        data: { deviceId, deviceToken: `${req.user.tenantId}.${deviceId}.${secret}`, expiresAt },
      });
    } catch (error) {
      console.error("[biometric.enroll]", error);
      return res.status(500).json({ success: false, message: "Could not enable biometric login" });
    }
  }

  // POST /api/auth/biometric/login   (public, rate limited)
  // body: { deviceToken }
  // 200: { success, accessToken, refreshToken }  - same shape as /api/auth/login
  static async login(req, res) {
    try {
      const parsed = parseDeviceToken(req.body && req.body.deviceToken);
      if (!parsed) return res.status(401).json(GENERIC_FAIL);
      const { tenantId, deviceId, secret } = parsed;

      const tenant = await masterModels.Tenant.findByPk(tenantId);
      if (!tenant || tenant.status !== "ACTIVE") return res.status(401).json(GENERIC_FAIL);

      const tenantDb = await masterModels.TenantDatabase.findOne({ where: { tenantId } });
      if (!tenantDb || tenantDb.status !== "READY") {
        return res.status(503).json({ success: false, message: "Tenant workspace is not ready" });
      }
      let conn;
      try {
        conn = await getTenantConnection(tenantId);
      } catch (err) {
        if (err instanceof TenantProvisioningError) {
          return res.status(503).json({ success: false, message: err.message });
        }
        throw err;
      }
      const { BiometricDevice, User, RefreshToken } = conn.models;

      const fail = async (reason, userId) => {
        await AuditService.log({
          models: conn.models, req, userId, tenantId,
          action: "BIOMETRIC_LOGIN_FAILED", module: "AUTH", status: "FAILED",
          remarks: `Biometric login failed: ${reason}`,
        });
        return res.status(401).json(GENERIC_FAIL);
      };

      const device = await BiometricDevice.findOne({ where: { deviceId, revokedAt: null } });
      if (!device) return fail("unknown or revoked device");
      if (!safeEqualHex(sha256(secret), device.secretHash)) return fail("secret mismatch", device.userId);
      if (new Date(device.expiresAt) <= new Date()) return fail("device credential expired", device.userId);

      const user = await User.findByPk(device.userId);
      if (!user) return fail("user not found", device.userId);
      if (!user.isActive) {
        await AuditService.log({
          models: conn.models, req, userId: user.id, tenantId,
          action: "BIOMETRIC_LOGIN_FAILED", module: "AUTH", status: "FAILED",
          remarks: `Biometric login blocked: ${user.email} is disabled`,
        });
        return res.status(403).json({ success: false, message: "User Disabled" });
      }
      if (!user.role) return fail("user has no role", user.id);

      // Same identity source the normal login uses: the user must still be
      // registered for THIS tenant in the Master DB's GlobalUserIndex.
      const indexEntry = await masterModels.GlobalUserIndex.findOne({
        where: { tenantId, tenantUserId: user.id },
      });
      if (!indexEntry) return fail("user not in global index", user.id);

      // Role/name/email are read fresh from the DATABASE - never from the phone.
      const identity = { id: user.id, name: user.name, role: user.role, tenantId, email: user.email };
      const accessToken = JwtService.generateAccessToken(identity);
      const refreshToken = JwtService.generateRefreshToken(identity);
      await RefreshToken.create({
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
      });

      await device.update({
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + DEVICE_TTL_DAYS * DAY_MS), // sliding expiry
      });

      await AuditService.log({
        models: conn.models, req, userId: user.id, username: user.name || user.email,
        role: user.role, tenantId, action: "BIOMETRIC_LOGIN", module: "AUTH",
        details: `User ${user.email} logged in with biometrics`, status: "SUCCESS",
      });

      return res.status(200).json({ success: true, accessToken, refreshToken });
    } catch (error) {
      console.error("[biometric.login]", error);
      return res.status(500).json({ success: false, message: "Biometric login is unavailable right now" });
    }
  }

  // POST /api/auth/biometric/disable   (authMiddleware)
  // body: { deviceId }  - user turns fingerprint login off for THIS phone
  static async disable(req, res) {
    try {
      if (!req.models) return res.json({ success: true });
      const { BiometricDevice } = req.models;
      const deviceId = req.body && typeof req.body.deviceId === "string" ? req.body.deviceId.toLowerCase() : null;
      if (!deviceId) return res.status(400).json({ success: false, message: "deviceId is required" });

      const [count] = await BiometricDevice.update(
        { revokedAt: new Date(), revokedReason: "USER_DISABLED" },
        { where: { deviceId, userId: req.user.id, revokedAt: null } },
      );
      if (count) {
        await AuditService.log({
          req, action: "BIOMETRIC_REVOKED", module: "AUTH", status: "SUCCESS",
          remarks: "User disabled biometric login on a device",
        });
      }
      return res.json({ success: true });
    } catch (error) {
      console.error("[biometric.disable]", error);
      return res.status(500).json({ success: false, message: "Could not disable biometric login" });
    }
  }

  // POST /api/auth/biometric/users/:userId/revoke   (TenantAdmin only)
  // body: { revokeSessions?: boolean }  - revoke ALL biometric devices of a user
  // (and optionally their refresh-token sessions). req.models is the admin's own
  // tenant DB, so an admin can never touch another tenant's users.
  static async adminRevoke(req, res) {
    try {
      if (!req.models) return res.status(403).json({ success: false, message: "Access Denied" });
      const { BiometricDevice, RefreshToken, User } = req.models;
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid userId" });
      }
      const target = await User.findByPk(userId);
      if (!target) return res.status(404).json({ success: false, message: "User not found" });

      const [count] = await BiometricDevice.update(
        { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED" },
        { where: { userId, revokedAt: null } },
      );
      if (req.body && req.body.revokeSessions === true) {
        await RefreshToken.update({ isRevoked: true }, { where: { userId, isRevoked: false } });
      }
      await AuditService.log({
        req, action: "BIOMETRIC_REVOKED", module: "AUTH", status: "SUCCESS",
        remarks: `Admin revoked ${count} biometric device(s) for ${target.email}`,
      });
      return res.json({ success: true, revoked: count });
    } catch (error) {
      console.error("[biometric.adminRevoke]", error);
      return res.status(500).json({ success: false, message: "Could not revoke devices" });
    }
  }
}

module.exports = BiometricAuthController;
