// src/services/sapEntityResolver.js
//
// ── DYNAMIC MULTI-TENANT SAP MAPPING (canonical resolver) ───────────────
//
// This module is the single place that turns "what does THIS tenant's SAP
// system actually call things" into the values the rest of the backend
// uses. Business logic (sapMasterSyncService, sapDocumentSyncService,
// sapHierarchyResolverService, sapService's upload/confirm flow) must
// NEVER read a hardcoded EntitySet / property / FunctionImport name
// directly — it asks this resolver instead, passing the tenant's
// ErpConfig row.
//
// Resolution order for everything below is:
//   1. Tenant-specific override on ErpConfig (entitySetMap / fieldMap /
//      functionMap columns — see migrations/20260723010000-*.js)
//   2. Legacy default (constants/sapSyncConstants.js) — this is exactly
//      today's Golyan configuration, so a tenant that configures nothing
//      keeps working exactly as before.
//
// Onboarding a brand-new SAP customer whose Gateway exposes different
// EntitySet/field/FunctionImport names therefore requires ONLY a new
// ErpConfig row with entitySetMap/fieldMap/functionMap filled in — no
// code change.

const {
  SAP_SYNC_ENTITY_SETS,
  SAP_SYNC_FUNCTION_IMPORTS,
  SAP_UPLOAD_RESPONSE_FIELDS,
  FIELD_CANDIDATES,
} = require("../constants/sapSyncConstants");

/**
 * Resolves the actual OData EntitySet name for a logical entity
 * ("DEPARTMENT" | "CATEGORY" | "DOCUMENT_TYPE" | "DOCUMENT").
 *
 * @param {object} erpConfig
 * @param {string} logicalEntity
 * @returns {string}
 */
function resolveEntitySet(erpConfig, logicalEntity) {
  const override = erpConfig?.entitySetMap?.[logicalEntity];
  if (override) return override;

  const fallback = SAP_SYNC_ENTITY_SETS[logicalEntity];
  if (!fallback) {
    throw new Error(
      `No EntitySet configured or defaulted for logical entity "${logicalEntity}". ` +
        `Add it to this tenant's entitySetMap.`,
    );
  }
  return fallback;
}

/**
 * Resolves the actual FunctionImport name for a logical operation
 * ("upload" | "confirm" | "uploadXstring").
 */
function resolveFunctionName(erpConfig, logicalFunction) {
  const override = erpConfig?.functionMap?.[logicalFunction];
  if (override) return override;

  const legacyKeyByLogical = {
    upload: SAP_SYNC_FUNCTION_IMPORTS.GENERATE_UPLOAD_URL,
    confirm: SAP_SYNC_FUNCTION_IMPORTS.CONFIRM_UPLOAD,
    uploadXstring: SAP_SYNC_FUNCTION_IMPORTS.UPLOAD_XSTRING,
  };
  const fallback = legacyKeyByLogical[logicalFunction];
  if (!fallback) {
    throw new Error(`Unknown logical FunctionImport "${logicalFunction}"`);
  }
  return fallback;
}

/**
 * Resolves the property name(s) SAP's upload FunctionImport response uses
 * for documentId / uploadUrl / phioId, honoring a per-tenant override.
 */
function resolveUploadResponseFields(erpConfig) {
  return {
    ...SAP_UPLOAD_RESPONSE_FIELDS,
    ...(erpConfig?.functionMap?.responseFields || {}),
  };
}

/**
 * Builds the effective, ordered list of property-name candidates
 * sapSyncFieldMap.pick() should probe for a given (logicalEntity,
 * logicalField) pair: the tenant's own configured field name first (if
 * any), then every legacy candidate already known to work for at least
 * one SAP flavor, de-duplicated.
 *
 * @param {object} erpConfig
 * @param {string} logicalEntity e.g. "DEPARTMENT"
 * @param {string} logicalField e.g. "code"
 * @returns {string[]}
 */
function resolveFieldCandidates(erpConfig, logicalEntity, logicalField) {
  const tenantOverride = erpConfig?.fieldMap?.[logicalEntity]?.[logicalField];
  const legacyCandidates = FIELD_CANDIDATES[logicalEntity]?.[logicalField] || [];

  if (!tenantOverride) return legacyCandidates;

  const merged = [tenantOverride, ...legacyCandidates];
  return [...new Set(merged)];
}

module.exports = {
  resolveEntitySet,
  resolveFunctionName,
  resolveUploadResponseFields,
  resolveFieldCandidates,
};
