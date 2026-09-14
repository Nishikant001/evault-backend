// src/services/tenantCleanupService.js
//
// Task 5 — Trial Expiry Cleanup.
//
// Hard-deletes EVERYTHING belonging to a FREE tenant once its trial has
// been expired for TRIAL_CLEANUP_GRACE_DAYS days (default 0 = immediately
// on the run after expiry). Only ever called by subscriptionScheduler,
// and only for tenantType === 'FREE' — PAID tenants are never touched by
// this service, no matter what.
//
// PHASE G (brief STEP 7): rewritten from a single-shared-DB transactional
// delete to the real Master DB -> Tenant -> TenantDatabase -> Tenant
// connection chain:
//   1. Look the tenant up in the MASTER DB (masterModels.Tenant).
//   2. Resolve its physical database (masterModels.TenantDatabase).
//   3. DROP that entire physical database — every one of the 34
//      tenant-owned tables (Document, User, ApprovalWorkflow, ... —
//      the same set src/database/legacyMigration/tenantTableRegistry.js
//      documents) lives ONLY in that one database, so dropping it IS
//      "delete everything belonging to this tenant," in one irreversible
//      step, with no risk of an orphaned child row surviving a partial
//      multi-table delete. Reuses tenantProvisioningService's own
//      dropPhysicalDatabase() (same admin-connection/identifier-
//      validation code createPhysicalDatabase() already uses) rather
//      than reimplementing DDL here.
//   4. Delete the tenant's rows in the Master DB itself — Subscription,
//      SubscriptionHistory, TenantDepartment (the tenant's link to the
//      shared/global Department master — never the Department row
//      itself), GlobalUserIndex (so the email/mobile become available
//      for a fresh signup again), TenantDatabase, and finally Tenant —
//      all inside one Master DB transaction.
//
// Design note on shared/global master data: Department and ErpConfig-type
// master data are shared, global rows (see PHASE_F_MIGRATION_REPORT.md
// section 1) — never touched here. Only the tenant's LINKS to them
// (TenantDepartment) are removed.
//
// Storage note: this codebase has no Cloudinary/S3 integration — FREE
// tenants store binaries only on local disk
// (uploads/free-tenant-documents/<tenantId>/, per localFinalizationService.js).
// That directory is removed. If Cloudinary/S3 support is added later, wire
// its delete call in removeLocalFiles() alongside the disk removal.

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { Op } = require("sequelize");
const masterModels = require("../models/masterDb");
const { closeTenantConnection, getTenantConnection } = require("./tenantConnectionManager");
const { dropPhysicalDatabase } = require("./tenantProvisioningService");

const LOCAL_STORAGE_ROOT = path.join(process.cwd(), "uploads", "free-tenant-documents");

/** Removes the tenant's local document storage directory and any lingering temp files it can identify. Best-effort — logged, never throws. */
async function removeLocalFiles(tenantId, documents) {
  const tenantDir = path.join(LOCAL_STORAGE_ROOT, String(tenantId));
  try {
    if (fsSync.existsSync(tenantDir)) {
      await fs.rm(tenantDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`[TenantCleanup] Failed removing local storage dir for tenant ${tenantId}:`, error.message);
  }

  for (const doc of documents) {
    if (doc.tempFilePath) {
      try {
        if (fsSync.existsSync(doc.tempFilePath)) await fs.unlink(doc.tempFilePath);
      } catch (error) {
        console.error(`[TenantCleanup] Failed removing temp file ${doc.tempFilePath}:`, error.message);
      }
    }
  }
}

class TenantCleanupService {
  /**
   * Deletes a single FREE tenant and everything scoped to it. Must be
   * called only for tenants whose subscription is already EXPIRED and
   * past the configured grace period — the scheduler enforces that,
   * this method trusts its caller and just executes the delete.
   */
  static async purgeTenant(tenantId) {
    const tenant = await masterModels.Tenant.findByPk(tenantId);
    if (!tenant) return { deleted: false, reason: "Tenant not found" };

    // Safety guard: this destructive path is FREE-only, always. A PAID
    // tenant reaching here (e.g. bad data / manual misuse) is refused.
    if (String(tenant.tenantType).toUpperCase() !== "FREE") {
      return { deleted: false, reason: "Refusing to purge a non-FREE tenant" };
    }

    const tenantDb = await masterModels.TenantDatabase.findOne({ where: { tenantId } });

    // ── Gather what we need for file cleanup + GlobalUserIndex removal
    // BEFORE dropping the physical database — once it's dropped there's
    // nothing left to read from it. ──────────────────────────────────
    let documents = [];
    let userEmails = [];
    let documentsRemoved = 0;
    let usersRemoved = 0;
    if (tenantDb && tenantDb.status === "READY" && tenantDb.databaseName) {
      try {
        const conn = await getTenantConnection(tenantId);
        documents = await conn.models.Document.findAll({ attributes: ["id", "tempFilePath"], raw: true });
        const users = await conn.models.User.findAll({ attributes: ["id", "email"], raw: true });
        userEmails = users.map((u) => u.email).filter(Boolean);
        documentsRemoved = documents.length;
        usersRemoved = users.length;
      } catch (error) {
        // Tenant DB unreachable — proceed with the drop anyway (that's
        // the actual goal); file/GlobalUserIndex cleanup is best-effort.
        console.error(`[TenantCleanup] Could not read tenant ${tenantId}'s DB before drop:`, error.message);
      }

      // Evict the cached connection BEFORE dropping the database — a
      // stale pooled connection pointing at a just-dropped database is
      // exactly the kind of bug this phase exists to eliminate.
      await closeTenantConnection(tenantId);
      await dropPhysicalDatabase(tenantDb.databaseName);
    }

    // ── Master DB rows, in one transaction ──────────────────────────
    const t = await masterModels.masterSequelize.transaction();
    try {
      await masterModels.SubscriptionHistory.destroy({ where: { tenantId }, transaction: t });
      await masterModels.Subscription.destroy({ where: { tenantId }, transaction: t });
      await masterModels.TenantDepartment.destroy({ where: { tenantId }, transaction: t });
      if (userEmails.length) {
        await masterModels.GlobalUserIndex.destroy({ where: { email: { [Op.in]: userEmails } }, transaction: t });
      }
      if (tenantDb) {
        await masterModels.TenantDatabase.destroy({ where: { tenantId }, transaction: t });
      }
      await masterModels.Tenant.destroy({ where: { id: tenantId }, transaction: t });
      await t.commit();
    } catch (error) {
      await t.rollback();
      console.error(`[TenantCleanup] Master DB purge failed for tenant ${tenantId}, rolled back:`, error.message);
      throw error;
    }

    // File-system cleanup happens AFTER everything else commits/drops —
    // if a DB step failed and threw above, we must not have already
    // destroyed files that the (still-existing) tenant needs.
    await removeLocalFiles(tenantId, documents);

    return { deleted: true, tenantId, documentsRemoved, usersRemoved };
  }
}

module.exports = TenantCleanupService;
