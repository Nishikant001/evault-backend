// src/services/sapSyncFieldMap.js
//
// Small, dependency-free helper used by the SAP sync services to read a
// logical field (e.g. "code", "departmentCode") off a raw SAP OData record
// without hardcoding one exact casing. See the FIELD_CANDIDATES comment in
// constants/sapSyncConstants.js for why this exists.

const { FIELD_CANDIDATES } = require("../constants/sapSyncConstants");
const { resolveFieldCandidates } = require("./sapEntityResolver");

/**
 * Returns the first non-empty value found on `record` for any of the
 * candidate keys, or `undefined` if none are present.
 */
function pick(record, candidateKeys) {
  if (!record) return undefined;
  if (!Array.isArray(candidateKeys)) return undefined;
  for (const key of candidateKeys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      return record[key];
    }
  }
  return undefined;
}

/**
 * Builds a { fieldName: candidateArray } lookup object for one entity,
 * honoring the given tenant's ErpConfig.fieldMap overrides (see
 * sapEntityResolver.resolveFieldCandidates) ahead of the legacy,
 * hardcoded candidate list. Passing no erpConfig preserves the exact
 * legacy behavior (candidate probing only).
 */
function candidatesFor(logicalEntity, erpConfig) {
  const legacy = FIELD_CANDIDATES[logicalEntity] || {};
  const fields = {};
  for (const fieldName of Object.keys(legacy)) {
    fields[fieldName] = erpConfig
      ? resolveFieldCandidates(erpConfig, logicalEntity, fieldName)
      : legacy[fieldName];
  }
  return fields;
}

/**
 * Normalizes a raw DepartmentSet record into { code, name, description, status }.
 * @param {object} record raw SAP row
 * @param {object} [erpConfig] tenant ErpConfig — enables per-tenant field overrides
 */
function mapDepartment(record, erpConfig) {
  const c = candidatesFor("DEPARTMENT", erpConfig);
  return {
    code: normalizeCode(pick(record, c.code)),
    name: pick(record, c.name),
    description: pick(record, c.description) ?? null,
    status: normalizeStatus(pick(record, c.status)),
  };
}

/**
 * Normalizes a raw CategorySet record into
 * { code, name, departmentCode, description, status }.
 */
function mapCategory(record, erpConfig) {
  const c = candidatesFor("CATEGORY", erpConfig);
  return {
    code: normalizeCode(pick(record, c.code)),
    name: pick(record, c.name),
    departmentCode: normalizeCode(pick(record, c.departmentCode)),
    description: pick(record, c.description) ?? null,
    status: normalizeStatus(pick(record, c.status)),
  };
}

/**
 * Normalizes a raw DocumentTypeSet record into
 * { code, name, categoryCode, description, status }.
 */
function mapDocumentType(record, erpConfig) {
  const c = candidatesFor("DOCUMENT_TYPE", erpConfig);
  return {
    code: normalizeCode(pick(record, c.code)),
    name: pick(record, c.name),
    categoryCode: normalizeCode(pick(record, c.categoryCode)),
    description: pick(record, c.description) ?? null,
    status: normalizeStatus(pick(record, c.status)),
  };
}

/**
 * Normalizes a raw DocumentMetaSet record into the fields the document
 * sync engine needs. `hasOriginal` is returned as a boolean (true only
 * when the raw value is exactly "X", per the SAP convention specified
 * in the brief).
 */
function mapDocumentMeta(record, erpConfig) {
  const c = candidatesFor("DOCUMENT_META", erpConfig);
  const rawHasOriginal = pick(record, c.hasOriginal);
  return {
    sapDocumentId: pick(record, c.sapDocumentId),
    sapPhioId: pick(record, c.sapPhioId) ?? null,
    fileName: pick(record, c.fileName) ?? null,
    description: pick(record, c.description) ?? null,
    hasOriginal:
      typeof rawHasOriginal === "string"
        ? rawHasOriginal.trim().toUpperCase() === "X"
        : !!rawHasOriginal,
    departmentCode: normalizeCode(pick(record, c.departmentCode)),
    categoryCode: normalizeCode(pick(record, c.categoryCode)),
    documentTypeCode: normalizeCode(pick(record, c.documentTypeCode)),
    mimeType: pick(record, c.mimeType) ?? null,
    createdOn: pick(record, c.createdOn) ?? null,
    // NEW — SAP Content API integration.
    tcode: pick(record, c.tcode) ?? null,
  };
}

function normalizeCode(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim();
}

function normalizeStatus(value) {
  if (!value) return "ACTIVE";
  const v = String(value).trim().toUpperCase();
  if (["INACTIVE", "I", "0", "BLOCKED", "DISABLED"].includes(v)) return "INACTIVE";
  return "ACTIVE";
}

module.exports = {
  pick,
  mapDepartment,
  mapCategory,
  mapDocumentType,
  mapDocumentMeta,
  normalizeCode,
  normalizeStatus,
};