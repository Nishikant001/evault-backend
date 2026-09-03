// src/constants/tenantMetadataDefaults.js
//
// Default tenant-facing hierarchy/labels — exactly today's Golyan wording
// and structure. Used by TenantController.getMyMetadata whenever a tenant's
// `metadata` column is null, so existing behavior is unchanged for the
// current tenant. New tenants override this shape via
// PUT /api/tenants/:id with a `metadata.hierarchy` array of their own.
//
// This mirrors the exact pattern already used for SAP field/entity mapping
// in constants/sapSyncConstants.js (SAP_SYNC_ENTITY_SETS etc.) — same idea,
// one layer up: those constants are the backend's fallback for talking to
// SAP; these are the frontend's fallback for what to call things.
const DEFAULT_HIERARCHY = [
  { key: "DEPARTMENT", label: "Department", level: 1, parentKey: null },
  { key: "CATEGORY", label: "Category", level: 2, parentKey: "DEPARTMENT" },
  { key: "DOCUMENT_TYPE", label: "Document Type", level: 3, parentKey: "CATEGORY" },
];

module.exports = {
  DEFAULT_HIERARCHY,
};
