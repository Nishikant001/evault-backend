// src/services/sapDocumentSyncService.js
//
// SAP Document Synchronization.
//
// Syncs DocumentMetaSet, importing ONLY records where HasOriginal = "X"
// (everything else is ignored, per the brief). Each record is upserted
// idempotently by its ORIGINAL SAP Document ID (Document.sapDocumentId,
// now unique — see models/Document.js): if a Document with that
// sapDocumentId already exists it is UPDATED, otherwise a new row is
// INSERTed. DepartmentCode/CategoryCode/DocumentTypeCode are resolved to
// local foreign keys; when any cannot be resolved yet, the document is
// still stored (never dropped) with sapSyncStatus = PENDING_CLASSIFICATION
// and the raw, unresolved codes preserved for later reclassification.
//
// AUTO-HIERARCHY (no more manual Department/Category/DocumentType setup):
// Before saving a document, the full Department -> Category -> Document
// Type hierarchy implied by its DepartmentCode/CategoryCode/
// DocumentTypeCode is automatically verified and, if any part of it is
// missing, created — see sapHierarchyResolverService.js. This runs INSIDE
// the same transaction as the document upsert (see upsertDocumentRecord
// below), so hierarchy creation and document import always commit or roll
// back together, and it never touches sapMasterSyncService.js (SAP Master
// Synchronization keeps running independently, on its own schedule).
//
// This module NEVER touches the existing local-upload flow
// (documentController.uploadDocument), OCR (ocrWorker/ocrService), or the
// Approval Workflow engine — synced documents are marked
// sourceType = 'SAP_SYNC' and uploadStatus = 'COMPLETED' (they already
// exist, with their original file, in SAP) so none of those engines ever
// pick them up as "in flight".
//
// DEADLOCK HANDLING:
// upsertDocumentRecord's transaction is wrapped in withDeadlockRetry() —
// see sapMasterSyncService.js for the full rationale. It's the same
// short read-then-write pattern (SELECT ... LOCK, then UPDATE/INSERT)
// run once per fetched record, so it's subject to the same InnoDB
// deadlock risk under concurrent sync runs. The hierarchy resolution now
// living inside this same transaction is subject to the identical risk,
// which is why it's covered by the same retry wrapper rather than a
// separate one.

const { masterSequelize, Department } = require("../models/masterDb");
const { getTenantConnection } = require("./tenantConnectionManager");
const SapService = require("./sapService");
const { getSapErpConfigForTenant } = require("./sapMasterSyncService");
const RetryQueueService = require("./sapRetryQueueService");
const withDeadlockRetry = require("../utils/withDeadlockRetry");
const { mapDocumentMeta } = require("./sapSyncFieldMap");
const HierarchyResolver = require("./sapHierarchyResolverService");
const {
  SAP_SYNC_ENTITY_TYPE,
  DOCUMENT_SOURCE_TYPE,
  DOCUMENT_SAP_SYNC_STATUS,
} = require("../constants/sapSyncConstants");
const { resolveEntitySet } = require("./sapEntityResolver");

/**
 * LEGACY / still exported for backward compatibility: resolves
 * DepartmentCode/CategoryCode/DocumentTypeCode to local ids WITHOUT
 * auto-creating anything missing (pure lookup). upsertDocumentRecord no
 * longer calls this — it now calls
 * HierarchyResolver.resolveOrCreateHierarchy() instead, which does the
 * same resolution but additionally creates whatever hierarchy nodes are
 * missing (the new requirement: administrators no longer have to
 * pre-create Department/Category/DocumentType by hand). Kept here in case
 * any external caller still depends on lookup-only semantics.
 * Returns { departmentId, categoryId, documentTypeId, resolved }
 * where `resolved` is false if ANY code could not be matched.
 */
async function resolveClassification(tenantId, mapped) {
  let departmentId = null;
  let categoryId = null;
  let documentTypeId = null;
  let resolved = true;

  const { models: tenantModels } = await getTenantConnection(tenantId);
  const { Category, DocumentType } = tenantModels;

  if (mapped.departmentCode) {
    const dept = await Department.findOne({ where: { sapCode: mapped.departmentCode } });
    if (dept) departmentId = dept.id;
    else resolved = false;
  } else {
    resolved = false;
  }

  if (mapped.categoryCode) {
    const cat = await Category.findOne({ where: { tenantId, sapCode: mapped.categoryCode } });
    if (cat) categoryId = cat.id;
    else resolved = false;
  } else {
    resolved = false;
  }

  if (mapped.documentTypeCode) {
    const docType = await DocumentType.findOne({ where: { tenantId, sapCode: mapped.documentTypeCode } });
    if (docType) documentTypeId = docType.id;
    else resolved = false;
  } else {
    resolved = false;
  }

  return { departmentId, categoryId, documentTypeId, resolved };
}

/**
 * Upserts ONE normalized DocumentMetaSet record for a tenant. Idempotent on
 * sapDocumentId. Returns { action: "created" | "updated", resolved, hierarchyLog }.
 *
 * `masterCache` is the { departments, categories, documentTypes } map built
 * once per sync run by HierarchyResolver.loadMasterCache(erpConfig) — see
 * syncDocuments() below. If it isn't supplied (e.g. a lone Retry Queue
 * re-attempt calling this outside a full syncDocuments() run), it is loaded
 * fresh here; a single extra SAP master-data fetch on a retry is
 * negligible and keeps retryDocumentRecord's external signature unchanged.
 *
 * TRANSACTION: hierarchy verification/creation (Step 1-3 of the brief) and
 * the document import (Step 4) all run inside this ONE transaction, so a
 * failure at any step rolls back everything — nothing is left half-created.
 */
async function upsertDocumentRecord(tenantId, mapped, masterCache) {
  const cache =
    masterCache ||
    (await HierarchyResolver.loadMasterCache(await getSapErpConfigForTenant(tenantId)));

    const { sequelize: tenantSequelize, models: tenantModels } = await getTenantConnection(tenantId);
  const { Document, Category, DocumentType } = tenantModels;

  return withDeadlockRetry(() =>
    masterSequelize.transaction((mt) =>
    tenantSequelize.transaction(async (tt) => {
      // STEP 1-3 — verify/auto-create Department -> Category -> DocumentType.
            const hierarchy = await HierarchyResolver.resolveOrCreateHierarchy(
        tenantId,
        mapped,
        cache,
        mt,
        tt,
        { Category, DocumentType },
      );

      for (const entry of hierarchy.log) {
        // "Department Created" / "Department Updated" / "Category Created" / ...
        const label = entry.entity === "DOCUMENT_TYPE" ? "DocumentType" : entry.entity[0] + entry.entity.slice(1).toLowerCase();
        console.log(`${label} ${entry.action === "created" ? "Created" : "Updated"} (sapCode=${entry.code}, tenantId=${tenantId})`);
      }
      if (!hierarchy.resolved) {
        console.log(`Classification Missing: ${hierarchy.pendingReason} (sapDocumentId=${mapped.sapDocumentId}, tenantId=${tenantId})`);
      }

      // STEP 4 — import/update the document itself with resolved FKs.
      const baseFields = {
        tenantId,
        departmentId: hierarchy.departmentId,
        categoryId: hierarchy.categoryId,
        documentTypeId: hierarchy.documentTypeId,
        originalFileName: mapped.fileName || `SAP_${mapped.sapDocumentId}`,
        mimeType: mapped.mimeType,
        sapDocumentId: mapped.sapDocumentId,
        sapPhioId: mapped.sapPhioId,
        sourceType: DOCUMENT_SOURCE_TYPE.SAP_SYNC,
        sapSyncStatus: hierarchy.resolved
          ? DOCUMENT_SAP_SYNC_STATUS.SYNCED
          : DOCUMENT_SAP_SYNC_STATUS.PENDING_CLASSIFICATION,
        sapRawDepartmentCode: mapped.departmentCode,
        sapRawCategoryCode: mapped.categoryCode,
        sapRawDocumentTypeCode: mapped.documentTypeCode,
        sapMetaSyncedAt: new Date(),
        // The document's binary already exists in SAP (HasOriginal = "X");
        // nothing further to process locally, so this mirrors the terminal
        // state the local-upload flow reaches after a successful finalize.
        uploadStatus: "COMPLETED",
        metadata: mapped.description ? { sapDescription: mapped.description } : null,
      };

            const existing = await Document.findOne({
  where: { sapDocumentId: mapped.sapDocumentId, tenantId },
  transaction: tt,
  lock: tt.LOCK.UPDATE,
});

     if (existing) {
  const fieldsToApply = { ...baseFields };

  if (!hierarchy.resolved) {
    // Naya resolution fail hua — purani (already-good) classification ko
    // kabhi overwrite mat karo. Sirf tab null bhejo jab document ke paas
    // pehle se bhi kuch classified nahi tha.
    fieldsToApply.departmentId = hierarchy.departmentId ?? existing.departmentId;
    fieldsToApply.categoryId = hierarchy.categoryId ?? existing.categoryId;
    fieldsToApply.documentTypeId = hierarchy.documentTypeId ?? existing.documentTypeId;

    // Agar existing document already fully classified tha, toh usko
    // PENDING_CLASSIFICATION me mat girao — SYNCED hi rehne do.
    if (existing.departmentId && existing.categoryId && existing.documentTypeId) {
      fieldsToApply.sapSyncStatus = existing.sapSyncStatus;
    }
  }

  await existing.update(fieldsToApply, { transaction: tt });
    console.log(`Document Updated (sapDocumentId=${mapped.sapDocumentId}, tenantId=${tenantId})`);
  return { action: "updated", resolved: hierarchy.resolved, hierarchyLog: hierarchy.log };
}

            await Document.create(
        { ...baseFields, uploadedBy: null, status: "ACTIVE", version: 1 },
        { transaction: tt }
      );
      console.log(`Document Imported (sapDocumentId=${mapped.sapDocumentId}, tenantId=${tenantId})`);
           return { action: "created", resolved: hierarchy.resolved, hierarchyLog: hierarchy.log };
    }),
    ),
  );
}

/**
 * Runs the full DocumentMetaSet sync for one tenant.
 */
async function syncDocuments({ tenantId, sapSyncLogId }) {
  const erpConfig = await getSapErpConfigForTenant(tenantId);

  // Ask SAP to filter server-side; still re-check client-side below in
  // case the target gateway ignores/partially supports $filter.
  const raw = await SapService.fetchEntitySet(erpConfig, resolveEntitySet(erpConfig, "DOCUMENT"), {
    filter: `HasOriginal eq 'X'`,
  });

  // Loaded ONCE for the whole run (not per-document — avoids N+1 SAP
  // calls) and reused by every hierarchy auto-creation below. See
  // sapHierarchyResolverService.js.
  const masterCache = await HierarchyResolver.loadMasterCache(erpConfig);

  const counters = {
    fetched: 0,
    created: 0,
    updated: 0,
    failed: 0,
    pendingClassification: 0,
    ignoredNoOriginal: 0,
  };
  const hierarchyCounters = {
    departmentsCreated: 0,
    departmentsUpdated: 0,
    categoriesCreated: 0,
    categoriesUpdated: 0,
    documentTypesCreated: 0,
    documentTypesUpdated: 0,
  };
  const errors = [];

  for (const rec of raw) {
    const mapped = mapDocumentMeta(rec, erpConfig);

    if (!mapped.hasOriginal) {
      // Defensive re-filter — ignore anything without an original, even if
      // the SAP gateway returned it despite our $filter.
      counters.ignoredNoOriginal += 1;
      continue;
    }

    counters.fetched += 1;

    if (!mapped.sapDocumentId) {
      counters.failed += 1;
      errors.push({ entityType: "DOCUMENT", code: "UNKNOWN", message: "DocumentMetaSet record missing DocumentId", timestamp: new Date() });
      continue;
    }

    try {
      const result = await upsertDocumentRecord(tenantId, mapped, masterCache);
      if (result.action === "created") counters.created += 1;
      else counters.updated += 1;
      if (!result.resolved) counters.pendingClassification += 1;

      for (const entry of result.hierarchyLog || []) {
        if (entry.entity === "DEPARTMENT") {
          if (entry.action === "created") hierarchyCounters.departmentsCreated += 1;
          else hierarchyCounters.departmentsUpdated += 1;
        } else if (entry.entity === "CATEGORY") {
          if (entry.action === "created") hierarchyCounters.categoriesCreated += 1;
          else hierarchyCounters.categoriesUpdated += 1;
        } else if (entry.entity === "DOCUMENT_TYPE") {
          if (entry.action === "created") hierarchyCounters.documentTypesCreated += 1;
          else hierarchyCounters.documentTypesUpdated += 1;
        }
      }
    } catch (error) {
      counters.failed += 1;
      errors.push({ entityType: "DOCUMENT", code: mapped.sapDocumentId, message: error.message, timestamp: new Date() });
      await RetryQueueService.enqueue({
        tenantId,
        entityType: SAP_SYNC_ENTITY_TYPE.DOCUMENT,
        referenceCode: mapped.sapDocumentId,
        payload: mapped,
        error,
        sapSyncLogId,
      });
    }
  }

  return {
    recordsFetched: counters.fetched,
    recordsCreated: counters.created,
    recordsUpdated: counters.updated,
    recordsFailed: counters.failed,
    recordsPendingClassification: counters.pendingClassification,
    recordsSkipped: counters.ignoredNoOriginal,
    summary: { DOCUMENT: counters, HIERARCHY: hierarchyCounters },
    errors,
  };
}

/**
 * Re-attempts exactly one previously-failed DocumentMetaSet record from
 * the Retry Queue. Used by sapRetryQueueService.processDueItems(). Signature
 * unchanged (tenantId, mapped) — sapSyncOrchestrator.js calls this exact
 * shape — so upsertDocumentRecord loads its own master-data cache when
 * called this way (see its doc comment).
 */
async function retryDocumentRecord(tenantId, mapped) {
  await upsertDocumentRecord(tenantId, mapped);
}

module.exports = {
  syncDocuments,
  upsertDocumentRecord,
  retryDocumentRecord,
  resolveClassification,
};