// src/middleware/authMiddleware.js
//
// PHASE E rewrite. BEFORE this phase: this file queried the legacy
// shared `User` table on every single request (`User.findByPk(decoded.id)`)
// to check isActive/role/tenantId, and unconditionally set
// `req.models = allModels` — meaning EVERY request, for every tenant,
// read and wrote the same one shared database, regardless of which
// tenant's own physical database (Phase A-D) actually existed for them.
// That's the exact problem this phase's brief describes and asks to be
// corrected.
//
// AFTER: this file does ONLY JWT verification and basic shape checks —
// no database query at all. It cannot yet know which database to check
// isActive/role against (SuperAdmin → Master DB; tenant user → their
// own tenant DB, which first requires resolving tenantId → physical
// database), so that verification is delegated to
// tenantResolverMiddleware.js, composed here rather than requiring
// every one of the ~26 route files to add a second middleware — every
// route already using authMiddleware gets full tenant resolution
// automatically, with a single, auditable change point.
const jwt = require("jsonwebtoken");
const tenantResolverMiddleware = require("./tenantResolverMiddleware");

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, message: "Authorization token missing" });
    }

    const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
    if (!token) {
      return res.status(401).json({ success: false, message: "Invalid token format" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!decoded || !decoded.id || !decoded.role) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // Identity/role/tenant claim from the SIGNED token only — isActive
    // and the user-actually-exists-in-their-tenant-DB checks happen in
    // tenantResolverMiddleware, which is the earliest point a database
    // capable of answering that question (Master DB, or the specific
    // tenant DB) is known.
    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      tenantId: decoded.tenantId ?? null,
    };

    return tenantResolverMiddleware(req, res, next);
  } catch (error) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
};

module.exports = authMiddleware;
