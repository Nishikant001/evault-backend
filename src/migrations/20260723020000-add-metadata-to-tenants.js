"use strict";

// ── Frontend metadata-driven terminology/hierarchy ──────────────────────
// This is a DIFFERENT layer than ErpConfig.entitySetMap/fieldMap/functionMap
// (added in 20260723010000-add-dynamic-sap-mapping-to-erp-configs.js), which
// solves how the BACKEND talks to a tenant's own SAP OData service.
//
// This column solves a separate problem: what the FRONTEND calls things.
// Department/Category/DocumentType remain fixed, 3-level canonical business
// entities in this application's own schema (see models/Department.js,
// Category.js, DocumentType.js and their FK relationships) — that is not
// changing here. What varies per tenant is only the display label and
// declared parent/child order for each of those 3 levels, e.g. a tenant
// that wants to see "Division / Business Unit / Document Class" instead of
// "Department / Category / Document Type".
//
// Nullable — a tenant with no override gets exactly today's Golyan wording
// via the DEFAULT_HIERARCHY fallback in constants/tenantMetadataDefaults.js,
// so this is a zero-behavior-change addition for the current tenant.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("tenants", "metadata", {
      type: Sequelize.JSON,
      allowNull: true,
      comment:
        'Tenant-facing terminology/hierarchy override, e.g. { "hierarchy": [ ' +
        '{ "key": "DEPARTMENT", "label": "Division", "level": 1, "parentKey": null }, ' +
        '{ "key": "CATEGORY", "label": "Business Unit", "level": 2, "parentKey": "DEPARTMENT" }, ' +
        '{ "key": "DOCUMENT_TYPE", "label": "Document Class", "level": 3, "parentKey": "CATEGORY" } ' +
        "] }. Falls back to constants/tenantMetadataDefaults.js when null.",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("tenants", "metadata");
  },
};
