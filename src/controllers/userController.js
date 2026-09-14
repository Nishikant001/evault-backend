// userController.js — complete with create, getAll, update, delete, profile, changePassword
//
// Phase 5: User is a per-tenant model now — reads through req.models
// instead of a static import. One exception, flagged where it happens:
// SuperAdmin's ?tenantId= cross-tenant view (getAll/update/remove) can't
// work through req.models (that's scoped to whichever tenant SuperAdmin's
// OWN JWT resolved to — SuperAdmin has none, see authMiddleware.js's
// bridge) — needs Phase 7's cross-tenant connection tooling.

const bcrypt = require("bcryptjs");
const AuditService = require("../services/auditService");
const masterModels = require("../models/masterDb");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

class UserController {

  // POST /api/users — TenantAdmin only
  static async create(req, res) {
    try {
      const { User } = req.models;
      const { name, email, password, role } = req.body;

      const exists = await User.findOne({ where: { email } });
      if (exists) {
        return res.status(400).json({ success: false, message: "Email Already Exists" });
      }

      const hash = await bcrypt.hash(password, 10);
            const user = await User.create({
        name,
        email,
        password: hash,
        role,
        tenantId: req.user.tenantId,
        isActive: true,
      });

      // ── Sync into Master DB GlobalUserIndex so login can resolve
      // this user's tenant (login checks GlobalUserIndex first — without
      // this row, a newly created user can never log in). ──────────
      await masterModels.GlobalUserIndex.findOrCreate({
        where: { email: user.email },
        defaults: {
          email: user.email,
          mobileNumber: user.mobileNumber || null,
          tenantId: req.user.tenantId,
          tenantUserId: user.id,
        },
      });

      // ── Audit: user created ─────────────────────────────────

      // ── Audit: user created ─────────────────────────────────
      await AuditService.log({
        req,
        module: AUDIT_MODULES.USER,
        action: AUDIT_ACTIONS.USER_CREATED,
        newValue: { id: user.id, name: user.name, email: user.email, role: user.role },
        remarks: `Created user ${user.email} with role ${user.role}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      return res.status(201).json({
        success: true,
        data: { ...user.toJSON(), password: undefined },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // GET /api/users — only users belonging to the same tenant
 // GET /api/users — TenantAdmin gets own tenant's users; SuperAdmin gets
// another tenant's users via ?tenantId=, read straight from that
// tenant's own physical database (SuperAdmin has no req.models of its
// own — see header comment).
static async getAll(req, res) {
  try {
    if (req.user.role === "SuperAdmin") {
      const tenantId = req.query.tenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: "tenantId required" });
      }

      const { getTenantConnection } = require("../services/tenantConnectionManager");
      const { models } = await getTenantConnection(tenantId);

      const users = await models.User.findAll({
        attributes: { exclude: ["password"] },
        order: [["createdAt", "DESC"]],
      });

      return res.json({ success: true, data: users });
    }

    const { User } = req.models;
    const tenantId = req.user.tenantId;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: "tenantId required" });
    }

    const users = await User.findAll({
      where: { tenantId },
      attributes: { exclude: ["password"] },
      order: [["createdAt", "DESC"]],
    });

    return res.json({ success: true, data: users });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

  // PUT /api/users/:id — update name, role, isActive (same tenant only)
  static async update(req, res) {
  try {
    if (req.user.role === "SuperAdmin") {
      return res.status(501).json({
        success: false,
        message: "Cross-tenant user editing is not yet available for SuperAdmin — coming in the Super Admin control plane phase.",
      });
    }

    const { User } = req.models;
    const { id } = req.params;
    const { name, role, isActive } = req.body;

    const user = await User.findOne({ where: { id, tenantId: req.user.tenantId } });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const oldRole = user.role;
    const oldValue = { name: user.name, role: user.role, isActive: user.isActive };

    if (name     !== undefined) user.name     = name;
    if (role     !== undefined) user.role      = role;
    if (isActive !== undefined) user.isActive  = isActive;

    await user.save();

    const updated = user.toJSON();
    delete updated.password;

    // ── Audit: user updated / role changed ───────────────────
    const roleChanged = role !== undefined && role !== oldRole;
    await AuditService.log({
      req,
      module: roleChanged ? AUDIT_MODULES.ROLE : AUDIT_MODULES.USER,
      action: roleChanged ? AUDIT_ACTIONS.ROLE_CHANGED : AUDIT_ACTIONS.USER_UPDATED,
      oldValue,
      newValue: { name: user.name, role: user.role, isActive: user.isActive },
      remarks: roleChanged
        ? `Changed role for user ${user.email} from ${oldRole} to ${user.role}`
        : `Updated user ${user.email}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

  // DELETE /api/users/:id — same tenant only
 static async remove(req, res) {
  try {
    if (req.user.role === "SuperAdmin") {
      return res.status(501).json({
        success: false,
        message: "Cross-tenant user deletion is not yet available for SuperAdmin — coming in the Super Admin control plane phase.",
      });
    }

    const { User } = req.models;
    const { id } = req.params;

    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ success: false, message: "You cannot remove yourself" });
    }

    const user = await User.findOne({ where: { id, tenantId: req.user.tenantId } });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const removedSnapshot = { id: user.id, name: user.name, email: user.email, role: user.role };
    await user.destroy();

    // ── Audit: user deleted ─────────────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.USER,
      action: AUDIT_ACTIONS.USER_DELETED,
      oldValue: removedSnapshot,
      remarks: `Removed user ${removedSnapshot.email}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, message: "User removed successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

  // GET /api/users/profile
  static async profile(req, res) {
    try {
      const { User } = req.models;
      const user = await User.findByPk(req.user.id, {
        attributes: { exclude: ["password"] },
      });
      return res.json({ success: true, data: user });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  // POST /api/users/change-password
  static async changePassword(req, res) {
    try {
      const { User } = req.models;
      const { oldPassword, newPassword } = req.body;

      const user = await User.findByPk(req.user.id);
      const valid = await bcrypt.compare(oldPassword, user.password);

      if (!valid) {
        return res.status(400).json({ success: false, message: "Old Password Invalid" });
      }

      user.password = await bcrypt.hash(newPassword, 10);
      await user.save();

      // ── Audit: password changed ─────────────────────────────
      await AuditService.log({
        req,
        module: AUDIT_MODULES.USER,
        action: AUDIT_ACTIONS.PASSWORD_CHANGED,
        remarks: `User ${user.email} changed their password`,
        status: AUDIT_STATUS.SUCCESS,
      });

      return res.json({ success: true, message: "Password Changed Successfully" });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = UserController;
