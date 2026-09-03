// src/middleware/accessControlMiddleware.js
//
// Reusable middleware for the Dynamic User Assignment Engine.
// Mirrors the factory pattern already used by roleMiddleware.js.
//
// Each factory returns an Express middleware that:
//   1. Lets SuperAdmin / TenantAdmin through untouched (they administer
//      the whole hierarchy — same behaviour as before this feature).
//   2. Lets a user with ZERO active UserAssignment rows through untouched
//      (backward compatibility — see userAssignmentService.js header).
//   3. Otherwise checks the resolved scope and returns 403 if the target
//      department/category/documentType is not in it.
//
// The id to check is resolved, in order, from: req.params, req.body,
// req.query — using the given field name (defaults match the existing
// route/query param names already used across categoryRoutes,
// documentTypeRoutes and documentRoutes, e.g. ":id" on category routes
// IS the categoryId itself).
//
// Usage:
//   router.put("/:id", auth, role("TenantAdmin"), checkCategoryAccess("id"), updateCategory);
//   router.get("/",    auth, role(...), checkDepartmentAccess("departmentId"), listCategories);

const userAssignmentService = require("../services/userAssignmentService");

function resolveParam(req, fieldName) {
  return (
    (req.params && req.params[fieldName]) ||
    (req.body && req.body[fieldName]) ||
    (req.query && req.query[fieldName]) ||
    null
  );
}

// ── Level 1: Department ───────────────────────────────────────
const checkDepartmentAccess = (fieldName = "departmentId") => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const departmentId = resolveParam(req, fieldName);
      if (!departmentId) return next(); // nothing to check yet — let controller validate

      const allowed = await userAssignmentService.hasDepartmentAccess(
        req.models,
        req.user.tenantId,
        req.user.id,
        req.user.role,
        departmentId
      );

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this department",
        });
      }

      return next();
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  };
};

// ── Level 2: Category ─────────────────────────────────────────
const checkCategoryAccess = (fieldName = "categoryId") => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const categoryId = resolveParam(req, fieldName);
      if (!categoryId) return next();

      const allowed = await userAssignmentService.hasCategoryAccess(
        req.models,
        req.user.tenantId,
        req.user.id,
        req.user.role,
        categoryId
      );

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this category",
        });
      }

      return next();
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  };
};

// ── Level 3: Document Type ────────────────────────────────────
const checkDocumentTypeAccess = (fieldName = "documentTypeId") => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const documentTypeId = resolveParam(req, fieldName);
      if (!documentTypeId) return next();

      const allowed = await userAssignmentService.hasDocumentTypeAccess(
        req.models,
        req.user.tenantId,
        req.user.id,
        req.user.role,
        documentTypeId
      );

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this document type",
        });
      }

      return next();
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  };
};

module.exports = {
  checkDepartmentAccess,
  checkCategoryAccess,
  checkDocumentTypeAccess,
};
