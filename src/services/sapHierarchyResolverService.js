// src/services/sapHierarchyResolverService.js
//
// AUTO-HIERARCHY RESOLUTION for SAP Document Synchronization.
//
// Removes the previous manual-setup requirement ("administrators must
// create Department -> Category -> Document Type before documents can be
// used"). Called ONLY from sapDocumentSyncService.js, from INSIDE the same
// Sequelize transaction as the Document upsert, so hierarchy creation and
// document import either all commit or all roll back together.
//
// This module is purely additive: it does NOT modify sapMasterSyncService.js
// (SAP Master Synchronization keeps running exactly as before, on its own
// schedule/trigger) — it just means Document Synchronization no longer has
// to WAIT for a prior Master Sync to have populated every node a document
// references. The two paths stay compatible because both match/upsert
// using the exact same idempotency key (sapCode, scoped the same way the
// models already declare — global for Department, per-tenant for
// Category/DocumentType) and the exact same field candidates
// (sapSyncFieldMap.js), so a node auto-created here is picked up and
// simply UPDATED (never duplicated) the next time a real Master Sync runs,
// and vice versa.
//
// WHY A MASTER-DATA CACHE:
// DocumentMetaSet only carries the raw classification CODES (DeptCode /
// CatCode / DtypeCode — see FIELD_CANDIDATES.DOCUMENT_META in
// constants/sapSyncConstants.js), never the Name/Description SAP holds for
// them. To satisfy "store sapCode, SAP Name, Description, Status" when
// auto-creating a node, this module reads the full DepartmentSet /
// CategorySet / DoctypeSet ONCE per sync run (loadMasterCache) and looks
// the code up there — hitting SAP once per document instead would be an
// N+1 call pattern, which the perf rules forbid. If a code truly isn't in
// the corresponding master set (a SAP data-quality gap), the node is still
// created — using the code itself as the name — rather than dropping the
// document; see resolveOrCreate* below.
//
// CONCURRENCY:
// Department is a GLOBAL row (shared across every tenant, same as in
// sapMasterSyncService.js). A local, in-process serialization chain
// (departmentWriteChain, mirroring the analogous guard already used by SAP
// Master Synchronization) keeps two Document Sync runs from writing to the
// same brand-new Department row at the same instant. This is a best-effort
// guard, not a correctness requirement: Department.sapCode/code/name are
// all unique-indexed, so even a genuine race just fails one of the two
// INSERTs with a duplicate-key error — that record is caught by
// syncDocuments' existing per-record try/catch, pushed onto the Retry
// Queue, and resolved cleanly on the next attempt (the row already exists
// by then, so the retry takes the UPDATE branch). Category/DocumentType
// writes are already scoped to one (tenantId, ...) at a time by the
// existing withTenantLock() in sapSyncOrchestrator.js.

const { Op } = require("sequelize");
const { Department, TenantDepartment } = require("../models/masterDb");
const SapService = require("./sapService");
const {
  mapDepartment,
  mapCategory,
  mapDocumentType,
  normalizeCode,
} = require("./sapSyncFieldMap");
const { resolveEntitySet } = require("./sapEntityResolver");

let departmentWriteChain = Promise.resolve();

function serializeDepartmentWrite(fn) {
  const run = departmentWriteChain.then(fn, fn);
  departmentWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Fetches the full DepartmentSet / CategorySet / DoctypeSet ONCE and
 * indexes each by its normalized code, so per-document hierarchy
 * resolution never re-hits SAP. Safe to call once per syncDocuments() run.
 */
async function loadMasterCache(erpConfig) {
  const [deptRaw, catRaw, typeRaw] = await Promise.all([
    SapService.fetchEntitySet(erpConfig, resolveEntitySet(erpConfig, "DEPARTMENT")),
    SapService.fetchEntitySet(erpConfig, resolveEntitySet(erpConfig, "CATEGORY")),
    SapService.fetchEntitySet(erpConfig, resolveEntitySet(erpConfig, "DOCUMENT_TYPE")),
  ]);

  const departments = new Map();
  for (const rec of deptRaw) {
    const mapped = mapDepartment(rec, erpConfig);
    if (mapped.code) departments.set(mapped.code.toUpperCase(), mapped);
  }

  const categories = new Map();
  for (const rec of catRaw) {
    const mapped = mapCategory(rec, erpConfig);
    if (mapped.code) categories.set(mapped.code.toUpperCase(), mapped);
  }

  const documentTypes = new Map();
  for (const rec of typeRaw) {
    const mapped = mapDocumentType(rec, erpConfig);
    if (mapped.code) documentTypes.set(mapped.code.toUpperCase(), mapped);
  }

  return { departments, categories, documentTypes };
}

/**
 * Builds the { code, name, description, status } payload to write for a
 * hierarchy node, preferring the full record from the master-data cache
 * and falling back to the bare code (so a document is never dropped just
 * because its parent node is missing from the cached master set).
 */
function resolveNodeFields(code, cacheMap, fallbackLabel) {
  const cached = cacheMap.get(code.toUpperCase());
  if (cached) return cached;
  return {
    code,
    name: code,
    description: `Auto-created from SAP Document Synchronization (${fallbackLabel} not present in current SAP master data)`,
    status: "ACTIVE",
  };
}

/**
 * Finds or creates the (global) Department by sapCode. Returns
 * { department, action: 'created' | 'updated' | 'unchanged' }.
 */
async function resolveOrCreateDepartment(rawCode, cache, transaction) {
  const code = normalizeCode(rawCode);

  return serializeDepartmentWrite(async () => {
    let existing = await Department.findOne({
      where: { sapCode: code },
      transaction,
    });

    if (!existing) {
      existing = await Department.findOne({
        where: {
          [Op.or]: [{ code: code.toUpperCase().slice(0, 50) }, { name: code }],
        },
        transaction,
      });
    }

    const mapped = resolveNodeFields(code, cache.departments, "Department");

    if (existing) {
      await existing.update(
        {
          sapCode: code,
          name: mapped.name,
          description: mapped.description,
          status: mapped.status,
          lastSyncedAt: new Date(),
        },
        { transaction },
      );
      return { department: existing, action: "updated" };
    }

    const created = await Department.create(
      {
        name: mapped.name,
        code: code.toUpperCase().slice(0, 50),
        description: mapped.description,
        status: mapped.status,
        sapCode: code,
        lastSyncedAt: new Date(),
      },
      { transaction },
    );
    return { department: created, action: "created" };
  });
}

/**
 * Finds or creates the tenant-scoped Category by (tenantId, sapCode),
 * linked to `department`. Also grants the tenant access to the parent
 * Department (TenantDepartment) if it doesn't have it yet — mirrors the
 * auto-assign step SAP Master Synchronization already performs for
 * CategorySet, so a hierarchy built via Document Sync ends up identical to
 * one built via Master Sync or created manually. Returns
 * { category, action: 'created' | 'updated' }.
 */
async function resolveOrCreateCategory(rawCode, department, tenantId, cache, masterTransaction, tenantTransaction, Category) {
    const code = normalizeCode(rawCode);

  let tenantDept = await TenantDepartment.findOne({
  where: { tenantId, departmentId: department.id },
  transaction: masterTransaction,
});
  if (!tenantDept) {
    await TenantDepartment.create(
  { tenantId, departmentId: department.id, status: "ACTIVE" },
  { transaction: masterTransaction },
);
  } else if (tenantDept.status !== "ACTIVE") {
    await tenantDept.update(
  { status: "ACTIVE" },
  { transaction: masterTransaction }
);
  }

  let existing = await Category.findOne({
  where: {
    tenantId,
    [Op.or]: [
      { sapCode: code },
      { name: code, departmentId: department.id },
    ],
  },
  transaction: tenantTransaction,
});

  const mapped = resolveNodeFields(code, cache.categories, "Category");

  if (existing) {
    await existing.update(
      {
        sapCode: code,
        name: mapped.name,
        departmentId: department.id,
        description: mapped.description,
        status: mapped.status,
        lastSyncedAt: new Date(),
      },
      { transaction: tenantTransaction },
    );
    return { category: existing, action: "updated" };
  }

  const created = await Category.create(
    {
      tenantId,
      departmentId: department.id,
      name: mapped.name,
      description: mapped.description,
      status: mapped.status,
      sapCode: code,
      lastSyncedAt: new Date(),
    },
    { transaction: tenantTransaction },
  );
  return { category: created, action: "created" };
}

/**
 * Finds or creates the tenant-scoped Document Type by (tenantId, sapCode),
 * linked to `category`. Returns { documentType, action: 'created' | 'updated' }.
 */
async function resolveOrCreateDocumentType(rawCode, category, tenantId, cache, tenantTransaction, DocumentType) {
    const code = normalizeCode(rawCode);

  let existing = await DocumentType.findOne({
  where: {
    tenantId,
    [Op.or]: [
      { sapCode: code },
      { name: code, categoryId: category.id },
    ],
  },
  transaction: tenantTransaction,
});

  const mapped = resolveNodeFields(code, cache.documentTypes, "Document Type");

  if (existing) {
    await existing.update(
      {
        sapCode: code,
        name: mapped.name,
        categoryId: category.id,
        description: mapped.description,
        status: mapped.status,
        lastSyncedAt: new Date(),
      },
      { transaction: tenantTransaction },
    );
    return { documentType: existing, action: "updated" };
  }

  const created = await DocumentType.create(
    {
      tenantId,
      categoryId: category.id,
      name: mapped.name,
      description: mapped.description,
      status: mapped.status,
      sapCode: code,
      lastSyncedAt: new Date(),
    },
    { transaction: tenantTransaction },
  );
  return { documentType: created, action: "created" };
}

/**
 * Resolves — auto-creating/updating whatever is missing — the full
 * Department -> Category -> Document Type hierarchy for one mapped
 * DocumentMetaSet record, all within the caller's transaction.
 *
 * Per the brief: a BLANK code (Department, Category, or DocumentType) is
 * never auto-created — the document must land as PENDING_CLASSIFICATION
 * instead. Resolution stops at the first blank/unresolvable level, but
 * whatever levels DO have a code are still resolved/created, so a document
 * missing only its DocumentTypeCode still gets linked to a real
 * Department + Category rather than losing all classification.
 *
 * Returns:
 *   {
 *     departmentId, categoryId, documentTypeId,
 *     resolved,      // true only if all three codes were present & resolved
 *     pendingReason, // set when resolved === false
 *     log: [ { entity, action, code } ],
 *   }
 */
async function resolveOrCreateHierarchy(tenantId, mapped, cache, masterTransaction, tenantTransaction, tenantModels) {
    const log = [];
  let departmentId = null;
  let categoryId = null;
  let documentTypeId = null;

  if (!mapped.departmentCode) {
    return { departmentId, categoryId, documentTypeId, resolved: false, pendingReason: "Missing DepartmentCode", log };
  }

  const { department, action: deptAction } = await resolveOrCreateDepartment(mapped.departmentCode, cache, masterTransaction);
  departmentId = department.id;
  log.push({ entity: "DEPARTMENT", action: deptAction, code: mapped.departmentCode });

  if (!mapped.categoryCode) {
    return { departmentId, categoryId, documentTypeId, resolved: false, pendingReason: "Missing CategoryCode", log };
  }

  const { category, action: catAction } = await resolveOrCreateCategory(mapped.categoryCode, department, tenantId, cache, masterTransaction, tenantTransaction, tenantModels.Category)
;
  categoryId = category.id;
  log.push({ entity: "CATEGORY", action: catAction, code: mapped.categoryCode });

  if (!mapped.documentTypeCode) {
    return { departmentId, categoryId, documentTypeId, resolved: false, pendingReason: "Missing DocumentTypeCode", log };
  }

  const { documentType, action: typeAction } = await resolveOrCreateDocumentType(mapped.documentTypeCode, category, tenantId, cache, tenantTransaction, tenantModels.DocumentType);
  documentTypeId = documentType.id;
  log.push({ entity: "DOCUMENT_TYPE", action: typeAction, code: mapped.documentTypeCode });

  return { departmentId, categoryId, documentTypeId, resolved: true, log };
}

module.exports = {
  loadMasterCache,
  resolveOrCreateHierarchy,
};