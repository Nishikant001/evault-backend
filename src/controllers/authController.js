const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// PHASE E — the two REAL places identity lives: SuperAdmin (Master DB)
// and GlobalUserIndex (Master DB), which points at a tenant's OWN
// database for everything else about that user (password hash,
// isActive, role, RefreshToken).
//
// PHASE G — the legacy shared-DB "tier 3" fallback that used to live in
// every method below has been REMOVED (brief STEP 3). Tenant users are
// now authenticated ONLY via GlobalUserIndex -> Tenant DB. SuperAdmin
// stays in the Master DB, unchanged.
const masterModels = require("../models/masterDb");
const { getTenantConnection, TenantProvisioningError } = require("../services/tenantConnectionManager");

const JwtService = require("../services/jwtService");
const AuditService = require("../services/auditService");

class AuthController {
  // PHASE G — two-tier identity resolution, tried in order:
  //   1. Master DB `super_admins` — platform-level, no tenant DB involved.
  //   2. Master DB `GlobalUserIndex` — every tenant user, whose real row
  //      lives inside their OWN tenant database. This is now the ONLY
  //      path for tenant users — there is no tier 3 anymore.
  static async login(req, res) {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ success: false, message: "email and password are required" });
      }

      // ── Tier 1: SuperAdmin (Master DB) ──────────────────────────
      const superAdmin = await masterModels.SuperAdmin.findOne({ where: { email } });
      if (superAdmin) {
        if (!superAdmin.isActive) {
          return res.status(403).json({ success: false, message: "User Disabled" });
        }
        const validPassword = await bcrypt.compare(password, superAdmin.password);
        if (!validPassword) {
          return res.status(401).json({ success: false, message: "Invalid Credentials" });
        }
        const identity = { id: superAdmin.id, role: "SuperAdmin", tenantId: null, email: superAdmin.email };
        const accessToken = JwtService.generateAccessToken(identity);
        const refreshToken = JwtService.generateRefreshToken(identity);
        // No Master-DB refresh-token store exists yet — this token is
        // signature-verified on use (see refreshToken() below) but not
        // individually revocable via logout(). Disclosed limitation,
        // see PHASE_E_FINAL_REPORT.md.
        return res.status(200).json({ success: true, accessToken, refreshToken });
      }

      // ── Tier 2: tenant user (GlobalUserIndex -> tenant DB) ──────
      const indexEntry = await masterModels.GlobalUserIndex.findOne({ where: { email } });
      if (!indexEntry) {
        return res.status(401).json({ success: false, message: "Invalid Credentials" });
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
      if (!user) {
        return res.status(401).json({ success: false, message: "Invalid Credentials" });
      }
      if (!user.isActive) {
        return res.status(403).json({ success: false, message: "User Disabled" });
      }
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        await AuditService.log({
          models: conn.models, req, userId: user.id, tenantId: indexEntry.tenantId,
          action: "LOGIN_FAILED", module: "AUTH", status: "FAILED",
          remarks: `Login failed for ${user.email}: invalid credentials`,
        });
        return res.status(401).json({ success: false, message: "Invalid Credentials" });
      }
      const identity = {
  id: user.id,
  name: user.name,
  role: user.role,
  tenantId: indexEntry.tenantId,
  email: user.email,
};
      const accessToken = JwtService.generateAccessToken(identity);
      const refreshToken = JwtService.generateRefreshToken(identity);
      await conn.models.RefreshToken.create({
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      await AuditService.log({
        models: conn.models,
        req,
        userId: user.id,
        username: user.name || user.email,
        role: user.role,
        tenantId: indexEntry.tenantId,
        action: "LOGIN",
        module: "AUTH",
        details: `User ${user.email} logged in`,
        status: "SUCCESS",
      });
      return res.status(200).json({ success: true, accessToken, refreshToken });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // PHASE G — dispatches by the (role/tenantId-bearing) refresh token
  // payload. No legacy tier — a tenantId claim ALWAYS resolves through
  // Master DB -> TenantDatabase -> tenant connection now; if it can't,
  // that's a 503, not a silent legacy-DB read.
  static async refreshToken(req, res) {
    try {
      const { refreshToken } = req.body;
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

      // ── SuperAdmin: no DB-backed revocation store yet (see login()) —
      // signature + expiry check above is the whole check. ──────────
      if (decoded.role === "SuperAdmin") {
        const superAdmin = await masterModels.SuperAdmin.findByPk(decoded.id);
        if (!superAdmin || !superAdmin.isActive) {
          return res.status(401).json({ success: false, message: "Refresh Token Expired" });
        }
        const accessToken = JwtService.generateAccessToken({ id: superAdmin.id, role: "SuperAdmin", tenantId: null, email: superAdmin.email });
        return res.json({ success: true, accessToken });
      }

      if (!decoded.tenantId) {
        return res.status(401).json({ success: false, message: "Invalid Refresh Token" });
      }

      const tenantDb = await masterModels.TenantDatabase.findOne({ where: { tenantId: decoded.tenantId } });
      if (!tenantDb || tenantDb.status !== "READY") {
        return res.status(503).json({ success: false, message: "Tenant workspace is not ready" });
      }
      const conn = await getTenantConnection(decoded.tenantId);
      const storedToken = await conn.models.RefreshToken.findOne({ where: { token: refreshToken, isRevoked: false } });
      if (!storedToken) {
        return res.status(401).json({ success: false, message: "Invalid Refresh Token" });
      }
      const user = await conn.models.User.findByPk(decoded.id);
      if (!user || !user.isActive) {
        return res.status(401).json({ success: false, message: "Refresh Token Expired" });
      }
      const accessToken = JwtService.generateAccessToken(user);
      return res.json({ success: true, accessToken });
    } catch (error) {
      return res.status(401).json({ success: false, message: "Refresh Token Expired" });
    }
  }

  // PHASE G — same two-tier dispatch as refreshToken(), so logout
  // actually revokes the token in the database it was issued from.
  static async logout(req, res) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        return res.json({ success: true, message: "Logged Out Successfully" });
      }

      let decoded;
      try {
        decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      } catch {
        decoded = null; // expired/invalid token — nothing to revoke, still a successful logout client-side
      }

      if (decoded && decoded.role === "SuperAdmin") {
        // No DB-backed store for SuperAdmin refresh tokens (see login()) — nothing to revoke.
        return res.json({ success: true, message: "Logged Out Successfully" });
      }

      if (decoded && decoded.tenantId) {
        const tenantDb = await masterModels.TenantDatabase.findOne({ where: { tenantId: decoded.tenantId } });
        if (tenantDb && tenantDb.status === "READY") {
          const conn = await getTenantConnection(decoded.tenantId);
          const storedToken = await conn.models.RefreshToken.findOne({ where: { token: refreshToken } });
          await conn.models.RefreshToken.update({ isRevoked: true }, { where: { token: refreshToken } });
          await AuditService.log({
            models: conn.models, req, userId: storedToken?.userId, action: "LOGOUT",
            module: "AUTH", details: "User Logged Out", status: "SUCCESS",
          });
          return res.json({ success: true, message: "Logged Out Successfully" });
        }
      }

      return res.json({ success: true, message: "Logged Out Successfully" });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // PHASE G — was a direct legacy shared-DB write; now creates the user
  // in the CALLING TenantAdmin's own tenant database (req.models, set by
  // tenantResolverMiddleware — this route runs behind authMiddleware).
  // Functionally equivalent to userController.create(), which is the
  // primary user-creation endpoint; kept working rather than removed, per
  // this phase's "do not modify business functionality unnecessarily."
  static async register(req, res) {
    try {
      if (!req.models) {
        return res.status(403).json({ success: false, message: "SuperAdmin cannot register a tenant user directly — no tenant context." });
      }
      const { User } = req.models;
      const { name, email, password, role } = req.body;
      const tenantId = req.user.tenantId;

      const exists = await User.findOne({ where: { email } });
      if (exists) {
        return res.status(400).json({ success: false, message: "Email Exists" });
      }
      const hash = await bcrypt.hash(password, 10);
      const user = await User.create({ name, email, password: hash, role: role || "Viewer", tenantId, isActive: true });

      const { GlobalUserIndex } = masterModels;
      await GlobalUserIndex.findOrCreate({
        where: { email },
        defaults: { email, mobileNumber: user.mobileNumber || null, tenantId, tenantUserId: user.id },
      });

      await AuditService.log({
        models: req.models, req, userId: req.user.id, action: "USER_CREATED", module: "USER",
        newValue: { name, email, role: role || "Viewer", tenantId },
        details: `Created user ${email}`, status: "SUCCESS",
      });
      return res.status(201).json({ success: true, data: user });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = AuthController;
