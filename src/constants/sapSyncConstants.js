// src/constants/sapSyncConstants.js
//
// Shared vocabulary + field-mapping config for the SAP Master Synchronization
// and SAP Document Synchronization module. Mirrors the pattern already used
// in constants/auditActions.js / assignmentConstants.js — plain constant
// objects, no framework dependency, safe to import from services, the
// controller, and the scheduler alike.
//
// FIELD MAPPING NOTE:
// This backend's existing SAP integration (sapService.js) talks to a custom
// Z-flavoured OData Gateway service whose FunctionImport results use
// non-standard casing (e.g. "Documentid", "Phioid", "Uploadurl" — see
// generateUploadUrlViaBatch). We do not know the exact property casing the
// target system uses for DepartmentSet / CategorySet / DocumentTypeSet /
// DocumentMetaSet, so every logical field below lists every casing variant
// we will probe for (PascalCase, the "Xxxid"-style casing already seen in
// this codebase, and a couple of common alternates). sapSyncFieldMap.js's
// `pick()` helper walks this list and uses the first key present on the
// record. If your actual SAP service exposes different field names, add
// them to the relevant array below — nothing else needs to change.

// ── LEGACY / DEFAULT TENANT (Golyan) ────────────────────────────────
// These constants remain exactly as they were: they are now used purely
// as the fallback defaults for tenants that do NOT define their own
// entitySetMap / fieldMap / functionMap on ErpConfig (see
// services/sapEntityResolver.js). Existing behavior for the current SAP
// customer is therefore unchanged — only NEW tenants with a different SAP
// backend need to configure overrides.
// FIX: this was previously missing `const`, which made it an implicit
// global (`SAP_SYNC_ENTITY_SETS` leaking onto the Node global object).
const SAP_SYNC_ENTITY_SETS = {
    DEPARTMENT: "DepartmentSet",
    CATEGORY: "CategorySet",
    DOCUMENT_TYPE: "DoctypeSet",   // FIX
    DOCUMENT: "DocumentMetaSet",
};

// Default SAP FunctionImport names (Golyan's Z-flavoured Gateway service).
// Per-tenant overrides live on ErpConfig.functionMap — see
// services/sapEntityResolver.js#resolveFunctionName.
const SAP_SYNC_FUNCTION_IMPORTS = {
  GENERATE_UPLOAD_URL: "GenerateUploadUrl",
  CONFIRM_UPLOAD: "ConfirmUpload",
  UPLOAD_XSTRING: "UploadDocumentXstring",
};

// Default property names SAP's batch/FunctionImport responses use for the
// upload result (see SapService.generateUploadUrlViaBatch /
// uploadDocumentXstring). Per-tenant overrides live on
// ErpConfig.functionMap.responseFields.
const SAP_UPLOAD_RESPONSE_FIELDS = {
  documentId: "Documentid",
  uploadUrl: "Uploadurl",
  phioId: "Phioid",
};

// Order in which master data MUST be synchronized (parent before child).
const MASTER_SYNC_ORDER = ["DEPARTMENT", "CATEGORY", "DOCUMENT_TYPE"];

const SAP_SYNC_TYPE = {
  MASTER: "MASTER",
  DOCUMENT: "DOCUMENT",
};

const SAP_SYNC_TRIGGER = {
  MANUAL: "MANUAL",
  SCHEDULED: "SCHEDULED",
  RETRY: "RETRY",
};

const SAP_SYNC_LOG_STATUS = {
  RUNNING: "RUNNING",
  SUCCESS: "SUCCESS",
  PARTIAL_SUCCESS: "PARTIAL_SUCCESS",
  FAILED: "FAILED",
};

const SAP_SYNC_ENTITY_TYPE = {
  DEPARTMENT: "DEPARTMENT",
  CATEGORY: "CATEGORY",
  DOCUMENT_TYPE: "DOCUMENT_TYPE",
  DOCUMENT: "DOCUMENT",
};

const SAP_RETRY_STATUS = {
  PENDING: "PENDING",
  RETRYING: "RETRYING",
  RESOLVED: "RESOLVED",
  ABANDONED: "ABANDONED",
};

const DOCUMENT_SOURCE_TYPE = {
  LOCAL_UPLOAD: "LOCAL_UPLOAD",
  SAP_SYNC: "SAP_SYNC",
};

const DOCUMENT_SAP_SYNC_STATUS = {
  SYNCED: "SYNCED",
  PENDING_CLASSIFICATION: "PENDING_CLASSIFICATION",
  FAILED: "FAILED",
};

// Roles permitted to execute / view synchronization. There is no dedicated
// "ERP Admin" role in the User model's role ENUM today (SuperAdmin is the
// role that already owns ErpConfig CRUD — see erpConfigRoutes.js), so
// SuperAdmin is treated as the "ERP Admin" for this module and TenantAdmin
// is the tenant-side operator, matching the brief's "Tenant Admin or ERP
// Admin" requirement as closely as the existing role model allows.
const SYNC_EXECUTE_ROLES = ["SuperAdmin", "TenantAdmin"];
const SYNC_VIEW_ROLES = ["SuperAdmin", "TenantAdmin"];

// Retry/backoff tuning — overridable via env vars at call sites.
const RETRY_DEFAULTS = {
  MAX_ATTEMPTS: 5,
  BASE_DELAY_MINUTES: 10, // attempt 1 waits 10m, attempt 2 waits 20m, ...
};

// Field-name candidates, in priority order, for each logical property.
// Each inner array is tried in order by sapSyncFieldMap.pick().
const FIELD_CANDIDATES = {
 DEPARTMENT: {
  code: [
    "DeptCode",
    "DepartmentCode",
    "Departmentcode",
    "Code"
  ],

  name: [
    "Description"
  ],

  description: [
    "Description"
  ],

  status: [
    "IsActive",
    "Status"
  ]
},
  CATEGORY: {
  code: [
    "CatCode",
    "CategoryCode",
    "Categorycode",
    "Code"
  ],

  name: [
    "Description"
  ],

  departmentCode: [
    "DeptCode",
    "DepartmentCode"
  ],

  description: [
    "Description"
  ],

  status: [
    "IsActive",
    "Status"
  ]
},
 DOCUMENT_TYPE: {
  code: [
    "DtypeCode",
    "DocumentTypeCode",
    "Code"
  ],

  name: [
    "Description"
  ],

  categoryCode: [
    "CatCode",
    "CategoryCode"
  ],

  description: [
    "Description"
  ],

  status: [
    "IsActive",
    "Status"
  ]
},
DOCUMENT_META: {
  // PHASE — SAP Content API integration: this same logical field list is
  // now also consumed by vaultUploadService.js (via
  // sapSyncFieldMap.mapDocumentMeta()) to read the metadata SAP posts
  // to POST /api/v1/vault/documents/upload, so that inbound channel is
  // driven by the SAME dynamic resolver/mapping architecture as the
  // existing OData sync instead of hardcoding one literal body-key
  // spelling. The camelCase entries below (sapDocumentId, fileName,
  // department, category, documentType) are the CURRENT confirmed SAP
  // Content API contract's own field names; the pre-existing
  // PascalCase/"Xxxid" entries remain the OData DocumentMetaSet
  // candidates. Both lists are additive and order-preserving, so
  // existing tenants (OData) and the existing SAP Content API contract
  // both keep matching on their first candidate — nothing here changes
  // resolution for either flow. A brand-new SAP landscape that spells
  // any of these differently (either over OData or over the Vault API)
  // still only needs an ErpConfig.fieldMap override — see
  // services/sapEntityResolver.js#resolveFieldCandidates.
  sapDocumentId: [
    "Documentid",
    "sapDocumentId",
    "SapDocumentId",
    "DocumentId"
  ],

  // Not present on the current DocumentMeta OData entity (see the metadata
  // XML — no Phioid/Mimetype property is exposed today), but listed here
  // so pick() always receives an array instead of `undefined` if
  // mapDocumentMeta() asks for these fields. If SAP later adds either
  // field, it will be picked up automatically; until then this simply
  // resolves to null.
  sapPhioId: [
    "Phioid",
    "PhioId"
  ],

  fileName: [
    "Filename",
    "fileName",
    "FileName"
  ],

  description: [
    "Description"
  ],

  hasOriginal: [
    "HasOriginal"
  ],

  departmentCode: [
    "DeptCode",
    "DepartmentCode",
    "department",
    "Department"
  ],

  categoryCode: [
    "CatCode",
    "CategoryCode",
    "category",
    "Category"
  ],

  documentTypeCode: [
    "DtypeCode",
    "DocumentTypeCode",
    "documentType",
    "DocumentType"
  ],

  mimeType: [
    "Mimetype",
    "MimeType",
    "ContentType"
  ],

  createdOn: [
    "CreatedAt"
  ],

  // NEW — required by the SAP Content API contract (Requirement: fileName,
  // documentType, department, category, sapDocumentId, tcode). Not part of
  // the current OData DocumentMetaSet entity, but added here (rather than
  // as a separate ad-hoc lookup in vaultUploadService.js) so a tenant
  // whose Gateway DOES expose a transaction-code property on
  // DocumentMetaSet in the future can map it via ErpConfig.fieldMap
  // without any code change, exactly like every other logical field
  // in this table.
  tcode: [
    "tcode",
    "Tcode",
    "TCode",
    "TransactionCode"
  ]
},
};

module.exports = {
  SAP_SYNC_ENTITY_SETS,
  SAP_SYNC_FUNCTION_IMPORTS,
  SAP_UPLOAD_RESPONSE_FIELDS,
  MASTER_SYNC_ORDER,
  SAP_SYNC_TYPE,
  SAP_SYNC_TRIGGER,
  SAP_SYNC_LOG_STATUS,
  SAP_SYNC_ENTITY_TYPE,
  SAP_RETRY_STATUS,
  DOCUMENT_SOURCE_TYPE,
  DOCUMENT_SAP_SYNC_STATUS,
  SYNC_EXECUTE_ROLES,
  SYNC_VIEW_ROLES,
  RETRY_DEFAULTS,
  FIELD_CANDIDATES,
};