"use strict";

// ─────────────────────────────────────────────────────────────
// Enterprise Check-In / Check-Out — Document locking.
//
// Purely ADDITIVE: only adds new nullable columns (+ a default-false
// boolean) and indexes to the existing `documents` table. No existing
// column is renamed, retyped, or dropped, so every current read/write
// against Document (uploadStatus, status, version, parentDocumentId,
// activityLogs, etc.) keeps working unchanged. Every new column defaults
// to "not locked" so pre-existing rows behave exactly as before.
//
// Lock state is intentionally kept OUT of the existing `status` ENUM
// (ACTIVE/ARCHIVED/DELETED) — that column is used as a soft-delete flag
// throughout the app (baseWhere: { status: "ACTIVE" } in ~8 places), so
// overloading it with CHECKED_OUT/CHECKED_IN would break every existing
// list/get/finalize query. isCheckedOut is a separate, orthogonal flag.
// ─────────────────────────────────────────────────────────────
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable("documents");

    const addColumnIfMissing = async (name, definition) => {
      if (!table[name]) {
        await queryInterface.addColumn("documents", name, definition);
      }
    };

    await addColumnIfMissing("isCheckedOut", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await addColumnIfMissing("checkedOutBy", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    });
    await addColumnIfMissing("checkedOutAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfMissing("lockReason", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await addColumnIfMissing("lockExpiry", {
      type: Sequelize.DATE,
      allowNull: true,
      comment: "Optional expected-return date supplied at check-out",
    });
    await addColumnIfMissing("checkedInBy", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    });
    await addColumnIfMissing("checkedInAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfMissing("checkInComments", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await addColumnIfMissing("forceUnlockedBy", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    });
    await addColumnIfMissing("forceUnlockedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfMissing("forceUnlockReason", {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    const addIndexSafe = async (fields, name) => {
      try {
        await queryInterface.addIndex("documents", fields, { name });
      } catch (e) {
        // Index likely already exists — safe to ignore in re-runs.
      }
    };

    await addIndexSafe(["isCheckedOut"], "idx_documents_isCheckedOut");
    await addIndexSafe(["checkedOutBy"], "idx_documents_checkedOutBy");
  },

  down: async (queryInterface) => {
    const removeColumnSafe = async (name) => {
      try {
        await queryInterface.removeColumn("documents", name);
      } catch (e) {
        // Column may not exist — safe to ignore.
      }
    };

    await removeColumnSafe("isCheckedOut");
    await removeColumnSafe("checkedOutBy");
    await removeColumnSafe("checkedOutAt");
    await removeColumnSafe("lockReason");
    await removeColumnSafe("lockExpiry");
    await removeColumnSafe("checkedInBy");
    await removeColumnSafe("checkedInAt");
    await removeColumnSafe("checkInComments");
    await removeColumnSafe("forceUnlockedBy");
    await removeColumnSafe("forceUnlockedAt");
    await removeColumnSafe("forceUnlockReason");
  },
};
