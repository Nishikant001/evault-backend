// src/database/tenant/migrations/20260826000001-make-requester-department-nullable.js
//
// FIX — Cross-Department Document Access requests were failing in two
// ways on already-provisioned tenants:
//
// 1) "Table 'tenant_X.document_access_requests' doesn't exist" —
//    tenants provisioned BEFORE this feature (DocumentAccessRequest /
//    CrossDepartmentDocumentShare models) was added never got these
//    tables created at all.
//
// 2) "notNull Violation: DocumentAccessRequest.requesterDepartmentId
//    cannot be null" — even once the table exists, the column was
//    defined NOT NULL while nothing in the request-creation flow ever
//    supplies it (the requester is, by definition, asking for a
//    document from a department they don't belong to — there is no
//    "their own department" to require here).
//
// This migration fixes BOTH, in order, for every already-provisioned
// tenant:
//
//   Step 1: defineTenantModels() + sequelize.sync() — same safe
//   pattern as 20260819000001-add-communication-tables.js. Without
//   `force`/`alter`, sync() only CREATES tables that don't exist yet;
//   it never touches tables that are already there. So this creates
//   document_access_requests / cross_department_document_shares (with
//   the already-corrected, nullable requesterDepartmentId column) for
//   any tenant missing them, and does nothing for tenants that already
//   have them.
//
//   Step 2: changeColumn — for tenants where the table already existed
//   (created before the nullable fix), explicitly relax the column.
//   This is a no-op (safe to re-run) for tables just created in Step 1,
//   since they were already created nullable.
//
// Any BRAND NEW tenant provisioned after this merge gets everything
// correct for free via migration 0001
// (20260813000001-create-tenant-schema.js), which builds the schema
// straight from the current model definitions.
module.exports = {
  async up(queryInterface, Sequelize, sequelize) {
    const { defineTenantModels } = require("../../../models/tenantModels");
    defineTenantModels(sequelize);
    await sequelize.sync();

    await queryInterface.changeColumn(
      "document_access_requests",
      "requesterDepartmentId",
      {
        type: Sequelize.INTEGER,
        allowNull: true,
      }
    );
  },

  async down(queryInterface) {
    // Not reverted automatically:
    // - Dropping document_access_requests / cross_department_document_shares
    //   here would destroy real user data (same "no destructive auto-down"
    //   stance as migration 0001 / 20260819000001).
    // - Reverting the column to NOT NULL would fail immediately if any
    //   row created after this migration has a NULL requesterDepartmentId
    //   (which is now the expected/common case).
    // Revert manually, outside of the migration runner, only if truly
    // required.
  },
};
