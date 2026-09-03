// src/services/checkInOutService.js
//
// Enterprise Check-In / Check-Out lock engine.
//
// Lock state always lives on the ROOT document of a version family (the
// row with parentDocumentId === null) so a lock covers the whole document
// regardless of which version id the caller queries — this mirrors the
// existing version-resolution pattern already used in
// documentController.getDocumentVersions.
//
// This service owns ALL check-in/check-out business rules in one place so
// it can be safely reused both by checkInOutController AND by the small
// lock guards added to the existing upload/delete flows in
// documentController.js, without duplicating lock rules anywhere.
//
// Nothing here touches SAP upload, OCR, or the Approval Workflow engine —
// check-in only creates a new Document version row via the same
// pattern documentController.uploadDocument already uses (temp file +
// Document.create + processOCR). SAP push and approval continue to happen
// exactly as they do today, via generate-tcode -> ApprovalEngineService
// -> finalize/SapFinalizationService.

// Phase 5: Document/AuditLog are per-tenant models now, and the
// transaction below must run against the TENANT's own database, not the
// old shared one. checkOut/checkIn/forceUnlock already accept a `req` in
// their params object — models/tenantDb are derived from it automatically
// (req.models / req.tenantDb, both set by Phase 4's authMiddleware),
// exactly like AuditService derives ip/device from req. Explicit
// `models`/`tenantDb` params remain available as an override for callers
// with no `req` (none currently, but keeps the door open).

const AuditService = require("./auditService");
const {
  AUDIT_ACTIONS,
  AUDIT_MODULES,
  AUDIT_STATUS,
} = require("../constants/auditActions");

// Roles allowed to check documents out / in — mirrors the existing upload
// role policy already enforced in documentRoutes.js. Viewer/Auditor/
// Approver stay read-only, exactly as they are for uploads today.
const CHECKOUT_ROLES = [
  "SuperAdmin",
  "TenantAdmin",
  "BranchManager",
  "DeptHead",
  "Manager",
  "Uploader",
];

// Roles allowed to force-unlock another user's checkout.
// "Department Admin" (per the business requirement) maps to the DeptHead
// role in this system's existing role enum. Kept as a single exported
// list so the Department Admin policy stays configurable in one place.
const FORCE_UNLOCK_ROLES = ["SuperAdmin", "TenantAdmin", "DeptHead"];

function makeError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

class CheckInOutService {
  static get CHECKOUT_ROLES() {
    return CHECKOUT_ROLES;
  }
  static get FORCE_UNLOCK_ROLES() {
    return FORCE_UNLOCK_ROLES;
  }

  /**
   * Resolves the ROOT document (the row that owns the lock) for any
   * version id, tenant-scoped, ACTIVE only. Returns null if not found.
   */
  static async resolveRoot(models, id, tenantId, transaction) {
    const { Document } = models;
    const doc = await Document.findOne({
      where: { id, tenantId, status: "ACTIVE" },
      transaction,
    });
    if (!doc) return null;
    if (!doc.parentDocumentId) return doc;

    return Document.findOne({
      where: { id: doc.parentDocumentId, tenantId, status: "ACTIVE" },
      transaction,
    });
  }

  /**
   * Guard used by other flows (upload new version, delete) to reject
   * actions from anyone who isn't the lock owner while the document is
   * checked out. No-op when unlocked or when the caller owns the lock.
   * Throws an Error with .statusCode = 423 (Locked) otherwise.
   */
  static assertNotLockedByOther(root, userId) {
    if (!root || !root.isCheckedOut) return;
    if (root.checkedOutBy === userId) return;

    throw makeError(
      `This document is checked out by another user and is locked for editing/deletion until it is checked in or force-unlocked.`,
      423
    );
  }

  /**
   * The family's true "latest version" is never root.version alone (see
   * the note in checkIn() above) — it's the max version across root +
   * all children, exactly as documentController.uploadDocument and
   * getDocumentVersions already compute it.
   */
  static async getLatestVersionNumber(models, rootId, tenantId, transaction) {
    const { Document } = models;
    const { Op } = require("sequelize");
    const latest = await Document.findOne({
      where: {
        [Op.or]: [{ id: rootId }, { parentDocumentId: rootId }],
        tenantId,
        status: "ACTIVE",
      },
      order: [["version", "DESC"]],
      transaction,
    });
    return latest ? latest.version : null;
  }

  static lockStatusPayload(root, currentVersion) {
    if (!root) return null;
    return {
      documentId: root.id,
      isCheckedOut: !!root.isCheckedOut,
      status: root.isCheckedOut ? "CHECKED_OUT" : "CHECKED_IN",
      currentVersion: currentVersion !== undefined ? currentVersion : root.version,
      checkedOutBy: root.checkedOutBy,
      checkedOutAt: root.checkedOutAt,
      lockReason: root.lockReason,
      lockExpiry: root.lockExpiry,
      checkedInBy: root.checkedInBy,
      checkedInAt: root.checkedInAt,
      checkInComments: root.checkInComments,
      forceUnlockedBy: root.forceUnlockedBy,
      forceUnlockedAt: root.forceUnlockedAt,
      forceUnlockReason: root.forceUnlockReason,
    };
  }

  static pushActivityLog(doc, message, status = "SUCCESS") {
    const logs = doc.activityLogs || [];
    logs.push({ message, status, timestamp: new Date() });
    return logs;
  }

  // ── CHECK OUT ────────────────────────────────────────────
  static async checkOut({ documentId, user, reason, expectedReturnDate, req, models: modelsArg, tenantDb: tenantDbArg }) {
    const models = modelsArg ?? req?.models;
    const tenantDb = tenantDbArg ?? req?.tenantDb;
    if (!models || !tenantDb) {
      throw makeError("checkOut requires `models`/`tenantDb` (or a `req` to derive them from)", 500);
    }
    return tenantDb.transaction(async (t) => {
      const root = await CheckInOutService.resolveRoot(models, documentId, user.tenantId, t);

      if (!root) {
        throw makeError("Document not found", 404);
      }

      if (root.isCheckedOut) {
        const isSameUser = root.checkedOutBy === user.id;
        await AuditService.log({
          req,
          module: AUDIT_MODULES.DOCUMENT,
          action: AUDIT_ACTIONS.DOCUMENT_CHECKOUT_DENIED,
          documentId: root.id,
          status: AUDIT_STATUS.FAILED,
          remarks: `Check-out denied for document ${root.id}: already checked out by user ${root.checkedOutBy}`,
        });
        throw makeError(
          isSameUser
            ? "You have already checked out this document."
            : "Document is already checked out by another user.",
          409
        );
      }

      const logs = CheckInOutService.pushActivityLog(
        root,
        `Checked out by user #${user.id}${reason ? " — " + reason : ""}`
      );

      await root.update(
        {
          isCheckedOut: true,
          checkedOutBy: user.id,
          checkedOutAt: new Date(),
          lockReason: reason || null,
          lockExpiry: expectedReturnDate || null,
          activityLogs: logs,
        },
        { transaction: t }
      );

      await AuditService.log({
        req,
        module: AUDIT_MODULES.DOCUMENT,
        action: AUDIT_ACTIONS.DOCUMENT_CHECKOUT,
        documentId: root.id,
        oldValue: { isCheckedOut: false },
        newValue: {
          isCheckedOut: true,
          checkedOutBy: user.id,
          lockReason: reason || null,
          lockExpiry: expectedReturnDate || null,
        },
        remarks: `Document ${root.id} checked out by user ${user.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      return root;
    });
  }

  // ── CHECK IN ─────────────────────────────────────────────
  // `newVersionDoc`, if provided, must already have been created by the
  // caller (checkInOutController) using the same pattern as
  // documentController.uploadDocument, BEFORE calling this method.
  static async checkIn({ documentId, user, comments, newVersionDoc, req, models: modelsArg, tenantDb: tenantDbArg }) {
    const models = modelsArg ?? req?.models;
    const tenantDb = tenantDbArg ?? req?.tenantDb;
    if (!models || !tenantDb) {
      throw makeError("checkIn requires `models`/`tenantDb` (or a `req` to derive them from)", 500);
    }
    return tenantDb.transaction(async (t) => {
      const root = await CheckInOutService.resolveRoot(models, documentId, user.tenantId, t);

      if (!root) {
        throw makeError("Document not found", 404);
      }

      if (!root.isCheckedOut) {
        throw makeError("Document is not currently checked out.", 400);
      }

      if (root.checkedOutBy !== user.id) {
        await AuditService.log({
          req,
          module: AUDIT_MODULES.DOCUMENT,
          action: AUDIT_ACTIONS.DOCUMENT_CHECKIN_DENIED,
          documentId: root.id,
          status: AUDIT_STATUS.FAILED,
          remarks: `Check-in denied for document ${root.id}: user ${user.id} is not the lock owner (${root.checkedOutBy})`,
        });
        throw makeError(
          "Only the user who checked out this document can check it in. Ask a Tenant/Department Admin to force-unlock it.",
          403
        );
      }

      const oldVersion = root.version;
      const newVersion = newVersionDoc ? newVersionDoc.version : root.version;

      const logs = CheckInOutService.pushActivityLog(
        root,
        `Checked in by user #${user.id}` +
          (newVersionDoc ? ` — version v${newVersion} created` : "") +
          (comments ? ` — ${comments}` : "")
      );

      await root.update(
        {
          isCheckedOut: false,
          checkedInBy: user.id,
          checkedInAt: new Date(),
          checkInComments: comments || null,
          // NOTE: root.version is intentionally left untouched here. The
          // rest of the codebase (documentController.uploadDocument,
          // getDocumentVersions, listDocuments) never trusts root.version
          // as "the latest version" — it always computes the family's
          // latest by querying MAX(version) across root + children. If we
          // overwrote root.version to match the new child's version here,
          // the two rows would collide on the same version number.
          activityLogs: logs,
        },
        { transaction: t }
      );

      await AuditService.log({
        req,
        module: AUDIT_MODULES.DOCUMENT,
        action: AUDIT_ACTIONS.DOCUMENT_CHECKIN,
        documentId: root.id,
        oldValue: { isCheckedOut: true, checkedOutBy: root.checkedOutBy, version: oldVersion },
        newValue: { isCheckedOut: false, checkedInBy: user.id, version: newVersion },
        remarks: `Document ${root.id} checked in by user ${user.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      if (newVersionDoc) {
        await AuditService.log({
          req,
          module: AUDIT_MODULES.DOCUMENT,
          action: AUDIT_ACTIONS.DOCUMENT_VERSION_CREATED,
          documentId: newVersionDoc.id,
          oldValue: { version: oldVersion },
          newValue: { version: newVersion },
          remarks: `New version v${newVersion} created for document ${root.id} via check-in`,
          status: AUDIT_STATUS.SUCCESS,
        });
      }

      return root;
    });
  }

  // ── FORCE UNLOCK ─────────────────────────────────────────
  static async forceUnlock({ documentId, user, reason, req, models: modelsArg, tenantDb: tenantDbArg }) {
    const models = modelsArg ?? req?.models;
    const tenantDb = tenantDbArg ?? req?.tenantDb;
    if (!models || !tenantDb) {
      throw makeError("forceUnlock requires `models`/`tenantDb` (or a `req` to derive them from)", 500);
    }
    if (!FORCE_UNLOCK_ROLES.includes(user.role)) {
      await AuditService.log({
        req,
        module: AUDIT_MODULES.DOCUMENT,
        action: AUDIT_ACTIONS.DOCUMENT_LOCK_DENIED,
        documentId,
        status: AUDIT_STATUS.FAILED,
        remarks: `Force-unlock denied: user ${user.id} (role ${user.role}) is not permitted`,
      });
      throw makeError("You do not have permission to force-unlock documents.", 403);
    }

    return tenantDb.transaction(async (t) => {
      const root = await CheckInOutService.resolveRoot(models, documentId, user.tenantId, t);

      if (!root) {
        throw makeError("Document not found", 404);
      }

      if (!root.isCheckedOut) {
        throw makeError("Document is not currently checked out.", 400);
      }

      const previousOwner = root.checkedOutBy;

      const logs = CheckInOutService.pushActivityLog(
        root,
        `Force-unlocked by user #${user.id} (${user.role})${reason ? " — " + reason : ""}`
      );

      await root.update(
        {
          isCheckedOut: false,
          forceUnlockedBy: user.id,
          forceUnlockedAt: new Date(),
          forceUnlockReason: reason || null,
          activityLogs: logs,
        },
        { transaction: t }
      );

      await AuditService.log({
        req,
        module: AUDIT_MODULES.DOCUMENT,
        action: AUDIT_ACTIONS.DOCUMENT_FORCE_UNLOCK,
        documentId: root.id,
        oldValue: { isCheckedOut: true, checkedOutBy: previousOwner },
        newValue: { isCheckedOut: false, forceUnlockedBy: user.id, reason: reason || null },
        remarks: `Document ${root.id} force-unlocked by user ${user.id} (${user.role}); was previously locked by user ${previousOwner}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      return root;
    });
  }
}

module.exports = CheckInOutService;
