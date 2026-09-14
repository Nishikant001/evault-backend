// src/services/localFinalizationService.js
//
// FREE-tenant equivalent of sapFinalizationService.finalizeDocumentToSap.
// Moves the already-written temp file (see documentController.uploadDocument
// — every upload writes to uploads/temp regardless of tenant type) into
// permanent local storage and marks the document COMPLETED. Crucially,
// this NEVER calls ErpFactory/SapService/erpService — no SAP code path is
// reachable from here, satisfying "never upload to SAP" at the code level,
// not just via a permission check.

const fs = require("fs");
const path = require("path");
const AuditService = require("./auditService");
const { AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

const LOCAL_STORAGE_ROOT = path.join(process.cwd(), "uploads", "free-tenant-documents");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * @param {object} document - a Document instance
 * @param {import('express').Request} [req] - optional, for audit context
 * @returns {Promise<{ localFilePath: string }>}
 */
async function finalizeDocumentLocally(document, req) {
  const logs = document.activityLogs || [];

  logs.push({
    message: "Saving document to local storage...",
    status: "PROCESSING",
    timestamp: new Date(),
  });
  await document.update({ activityLogs: logs, uploadStatus: "SAVING_TO_SAP" }); // status enum reused ("SAVING_TO_SAP" = "persisting binary", label kept for FE compatibility

  if (!document.tempFilePath || !fs.existsSync(document.tempFilePath)) {
    throw new Error("Uploaded file not found on disk (tempFilePath missing)");
  }

  const tenantDir = path.join(LOCAL_STORAGE_ROOT, String(document.tenantId));
  ensureDir(tenantDir);

  const permanentFileName = `${document.id}_${path.basename(document.tempFilePath)}`;
  const permanentPath = path.join(tenantDir, permanentFileName);

  fs.copyFileSync(document.tempFilePath, permanentPath);
  // Unlike the SAP path, we do NOT delete the temp file's content — we
  // simply stop treating it as the document's location of record from
  // here on (tempFilePath is left as a historical breadcrumb; localFilePath
  // is authoritative).

  logs.push({
    message: "Document stored locally (FREE plan — SAP not used)",
    status: "SUCCESS",
    timestamp: new Date(),
  });

  await document.update({
    localFilePath: permanentPath,
    uploadStatus: "COMPLETED",
    activityLogs: logs,
  });

  await AuditService.log({
    req,
    module: AUDIT_MODULES.DOCUMENT,
    action: "LOCAL_FINALIZE",
    documentId: document.id,
    newValue: { localFilePath: permanentPath },
    remarks: `Document ${document.id} finalized to local storage (FREE tenant, no SAP call)`,
    status: AUDIT_STATUS.SUCCESS,
  });

  return { localFilePath: permanentPath };
}

module.exports = { finalizeDocumentLocally };
