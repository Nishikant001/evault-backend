// src/services/userAssignmentService.js
//
// Core resolution logic for the Dynamic User Assignment Engine.
//
// Permission rule (per requirement):
//   DEPARTMENT assignment    → all Categories, all DocumentTypes, all
//                              Documents under that department.
//   CATEGORY assignment      → only that Category, its DocumentTypes,
//                              its Documents.
//   DOCUMENT_TYPE assignment → only that DocumentType, its Documents.
//
// Backward compatibility rule (IMPORTANT — this is what keeps every
// existing API working unchanged for tenants that never touch the new
// engine): a user with ZERO active UserAssignment rows is treated as
// "unrestricted" and keeps seeing everything their role already allowed
// under the pre-existing tenant-scoped queries. Restriction only kicks in
// once a TenantAdmin has explicitly assigned that user to at least one
// department/category/document type. SuperAdmin and TenantAdmin are
// always unrestricted (they administer the whole tenant/hierarchy).
//
// Every function below is read-only and side-effect free, so it is safe
// to call from middleware, controllers, or other services.
//
// Phase 5: every function now takes `models` (the tenant-scoped model
// set, from req.models) as its FIRST parameter — UserAssignment/Category/
// DocumentType are all per-tenant models now, so there's no static import
// left to fall back to.

const { ASSIGNMENT_LEVELS, ASSIGNMENT_STATUS } = require("../constants/assignmentConstants");

const UNRESTRICTED_ROLES = new Set(["SuperAdmin", "TenantAdmin"]);

// ── Fetch a user's active assignments (raw rows) ─────────────
async function getActiveAssignments(models, tenantId, userId) {
  const { UserAssignment } = models;
  return UserAssignment.findAll({
    where: { tenantId, userId, status: ASSIGNMENT_STATUS.ACTIVE },
  });
}

// Returns null when the user is unrestricted (no scoping should be
// applied at all — caller must fall back to existing tenant-only logic).
// Returns { departmentIds, categoryIds, documentTypeIds } otherwise —
// each array already includes everything cascaded down from a higher
// level assignment (e.g. a DEPARTMENT assignment also populates
// categoryIds/documentTypeIds with every category/doctype under it).
async function resolveScope(models, tenantId, userId, role) {
  if (UNRESTRICTED_ROLES.has(role)) return null;

  const { Category, DocumentType } = models;
  const assignments = await getActiveAssignments(models, tenantId, userId);
  if (!assignments.length) return null; // backward compatibility

  const departmentIds = new Set();
  const directCategoryIds = new Set();
  const directDocumentTypeIds = new Set();

  for (const a of assignments) {
    if (a.assignmentLevel === ASSIGNMENT_LEVELS.DEPARTMENT && a.departmentId) {
      departmentIds.add(a.departmentId);
    } else if (a.assignmentLevel === ASSIGNMENT_LEVELS.CATEGORY && a.categoryId) {
      directCategoryIds.add(a.categoryId);
    } else if (a.assignmentLevel === ASSIGNMENT_LEVELS.DOCUMENT_TYPE && a.documentTypeId) {
      directDocumentTypeIds.add(a.documentTypeId);
    }
  }

  const categoryIds = new Set(directCategoryIds);
  const documentTypeIds = new Set(directDocumentTypeIds);

  // Cascade DEPARTMENT → all its categories
  if (departmentIds.size) {
    const cascadedCategories = await Category.findAll({
      where: { tenantId, departmentId: Array.from(departmentIds) },
      attributes: ["id"],
    });
    cascadedCategories.forEach((c) => categoryIds.add(c.id));
  }

  // Cascade (DEPARTMENT's + directly assigned) categories → all their document types
  if (categoryIds.size) {
    const cascadedDocTypes = await DocumentType.findAll({
      where: { tenantId, categoryId: Array.from(categoryIds) },
      attributes: ["id"],
    });
    cascadedDocTypes.forEach((dt) => documentTypeIds.add(dt.id));
  }

  return {
    departmentIds: Array.from(departmentIds),
    categoryIds: Array.from(categoryIds),
    documentTypeIds: Array.from(documentTypeIds),
  };
}

// ── Single-record access checks (used by middleware) ────────

async function hasDepartmentAccess(models, tenantId, userId, role, departmentId) {
  const scope = await resolveScope(models, tenantId, userId, role);
  if (scope === null) return true; // unrestricted
  return scope.departmentIds.includes(Number(departmentId));
}

async function hasCategoryAccess(models, tenantId, userId, role, categoryId) {
  const scope = await resolveScope(models, tenantId, userId, role);
  if (scope === null) return true;
  return scope.categoryIds.includes(Number(categoryId));
}

async function hasDocumentTypeAccess(models, tenantId, userId, role, documentTypeId) {
  const scope = await resolveScope(models, tenantId, userId, role);
  if (scope === null) return true;
  return scope.documentTypeIds.includes(Number(documentTypeId));
}

module.exports = {
  UNRESTRICTED_ROLES,
  getActiveAssignments,
  resolveScope,
  hasDepartmentAccess,
  hasCategoryAccess,
  hasDocumentTypeAccess,
};
