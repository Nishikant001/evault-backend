// src/database/tenant/migrations/20260827000001-drop-tcode-unique-constraint.js
//
// FIX — SAP Content API bug found during Phase 1-5 audit/testing.
//
// documents.tcode was defined with `unique: true` in both
// models/Document.js and models/tenantModels/Document.js. tcode is the
// SAP transaction code that originated an upload (e.g. "ZDMS_UPLOAD");
// SAP legitimately reuses the same tcode across many different document
// uploads. sapDocumentId (already unique, and the field the SAP Content
// API actually uses as its idempotency key — see vaultUploadService.js)
// is the correct per-document identifier.
//
// With the unique constraint left in place, the SECOND document ever
// uploaded through POST /api/v1/vault/documents/upload with a tcode
// that had already been used once would fail with a
// SequelizeUniqueConstraintError -> 409, even though it is a brand new
// sapDocumentId. That is a functional bug, not a security control, so
// this migration removes the constraint for every already-provisioned
// tenant.
//
// Brand-new tenants provisioned after this fix get the corrected schema
// for free via migration 0001 (20260813000001-create-tenant-schema.js),
// which builds straight from the current (now-corrected) model
// definitions — tcode is simply never created as unique for them.
//
// The exact auto-generated index name varies by how/when a given
// tenant database was created, so this looks it up from
// information_schema instead of guessing a fixed name, and is a no-op
// (safe to re-run) if no unique index on tcode is found.
"use strict";

module.exports = {
  async up(queryInterface, Sequelize, sequelize) {
    const table = await queryInterface.describeTable("documents").catch(() => null);
    if (!table || !table.tcode) {
      // Tenant doesn't have a documents table / tcode column yet at all
      // (shouldn't happen in practice, but keep this migration a no-op
      // rather than erroring if it does).
      return;
    }

    const dbName = sequelize.getDatabaseName
      ? sequelize.getDatabaseName()
      : sequelize.config.database;

    const [indexes] = await sequelize.query(
      `SELECT DISTINCT INDEX_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = :dbName
          AND TABLE_NAME = 'documents'
          AND COLUMN_NAME = 'tcode'
          AND NON_UNIQUE = 0
          AND INDEX_NAME != 'PRIMARY'`,
      { replacements: { dbName } }
    );

    for (const { INDEX_NAME: indexName } of indexes) {
      await queryInterface.removeIndex("documents", indexName).catch((err) => {
        // Defense-in-depth: if two tenant migration runs race, or the
        // index was already removed by hand, don't fail the migration.
        // eslint-disable-next-line no-console
        console.warn(
          `[migration 20260827000001] could not drop index "${indexName}" on documents.tcode: ${err.message}`
        );
      });
    }
  },

  async down(queryInterface, Sequelize) {
    // Intentionally not reverted: re-adding a unique constraint here
    // could immediately fail (or silently coexist with duplicate tcode
    // values already written after this fix shipped), and the
    // constraint being removed is the whole point of this migration.
  },
};
