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
   // No active assignment => user can access NOTHING (not everything)
  if (!assignments.length) {
    return { departmentIds: [], categoryIds: [], documentTypeIds: [] };
  }

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

// ── Resolve which Plants / CompanyCodes a scoped user can see ──
// Company Code and Plant sit ABOVE Department in the hierarchy, and
// Department itself lives in the shared Master DB (not in `models`,
// which is tenant-scoped), so resolveScope() above can't reach them
// directly. This helper takes the department/category/documentType
// scope resolveScope() already computed and walks it back UP to the
// accessible Plant and CompanyCode ids, via each department's
// TenantDepartmentPlant mapping (per-tenant).
//
// Pass it the SAME `scope` object resolveScope() returned.
// Returns null when scope is null (unrestricted — caller should show
// everything, same convention as resolveScope). Otherwise returns
// { departmentIds, plantIds, companyCodeIds } — any of which may be an
// EMPTY array, meaning "this user has nothing to see at this level".
async function resolveLocationScope(models, tenantId, scope) {
  if (!scope) return null;

  const { Category, DocumentType, TenantDepartmentPlant, Plant } = models;

  // Widen departmentIds to also cover CATEGORY/DOCUMENT_TYPE-level
  // assignments — resolveScope() only populates departmentIds for
  // DEPARTMENT-level rows, so a user assigned at Category or
  // DocumentType level would otherwise look like they have zero
  // accessible departments (and therefore zero plants/company codes),
  // even though they can see documents under that category/doc-type fine.
  const departmentIds = new Set(scope.departmentIds);

  if (scope.categoryIds.length) {
    const cats = await Category.findAll({
      where: { tenantId, id: scope.categoryIds },
      attributes: ["departmentId"],
      raw: true,
    });
    cats.forEach((c) => c.departmentId && departmentIds.add(c.departmentId));
  }

  if (scope.documentTypeIds.length) {
    const dts = await DocumentType.findAll({
      where: { tenantId, id: scope.documentTypeIds },
      attributes: ["categoryId"],
      raw: true,
    });
    const catIdsFromDts = [...new Set(dts.map((d) => d.categoryId).filter(Boolean))];
    if (catIdsFromDts.length) {
      const catsFromDts = await Category.findAll({
        where: { tenantId, id: catIdsFromDts },
        attributes: ["departmentId"],
        raw: true,
      });
      catsFromDts.forEach((c) => c.departmentId && departmentIds.add(c.departmentId));
    }
  }

  const departmentIdList = Array.from(departmentIds);
  if (!departmentIdList.length) {
    return { departmentIds: [], plantIds: [], companyCodeIds: [] };
  }

  const mappings = await TenantDepartmentPlant.findAll({
    where: { tenantId, departmentId: departmentIdList, status: "ACTIVE" },
    attributes: ["plantId"],
    raw: true,
  });
  const plantIds = [...new Set(mappings.map((m) => m.plantId))];
  if (!plantIds.length) {
    return { departmentIds: departmentIdList, plantIds: [], companyCodeIds: [] };
  }

  const plants = await Plant.findAll({
    where: { tenantId, id: plantIds },
    attributes: ["companyCodeId"],
    raw: true,
  });
  const companyCodeIds = [...new Set(plants.map((p) => p.companyCodeId))];

  return { departmentIds: departmentIdList, plantIds, companyCodeIds };
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
  resolveLocationScope,
  hasDepartmentAccess,
  hasCategoryAccess,
  hasDocumentTypeAccess,
};