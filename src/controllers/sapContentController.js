// src/controllers/sapContentController.js
//
// PHASE 4 — SAP Content API document RETRIEVAL.
//
// req.tenant / req.models / req.masterModels / req.sapAuth are set
// EXCLUSIVELY by sapVaultAuthMiddleware (see routes/vaultRoutes.js) —
// nothing in this controller resolves tenant identity, authenticates
// SAP, or reads a tenant identifier from the request itself. This
// controller's only job is: validate the route param, hand it to
// sapContentRetrievalService, and translate the result into a raw
// binary HTTP response with correct headers.
//
// This file does NOT touch documentController.js's existing portal
// /:id/view or /:id/download routes, and does NOT call out to SAP's own
// Content Server / ErpFactory — the binary already lives in our
// DocumentContent table (written by vaultController.js's upload path).
"use strict";

const {
  SapContentRetrievalError,
  getSapDocumentContent,
} = require("../services/sapContentRetrievalService");
const { BROWSER_VIEWABLE_MIME_TYPES } = require("../constants/vaultUploadConstants");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const { structuredLog } = require("../middleware/requestContextMiddleware");

/**
 * Builds a safe Content-Disposition header value. Mirrors the exact
 * sanitization already used by documentController.js / crossDepartment/
 * sapSyncExt controllers for this codebase's other file-serving routes:
 * strip double-quote characters so the caller-declared filename can
 * never break out of the quoted-string header value. The filename is
 * NEVER used to build a filesystem path (Requirement 10 — no internal
 * storage paths are ever exposed; this is a display-only HTTP header).
 *
 * Defense in depth: originalFileName is already sanitized (no control
 * characters, including CR/LF) by vaultUploadService.sanitizeFileName at
 * write time, for every document this endpoint can ever serve (see
 * sourceType === VAULT_SOURCE_TYPE gate in sapContentRetrievalService).
 * Stripping CR/LF/other control characters again here costs nothing and
 * means this function stays safe on its own even if that upstream
 * invariant ever changes.
 */
function buildContentDisposition(disposition, fileName) {
  // eslint-disable-next-line no-control-regex
  const safeName = String(fileName || "document").replace(/["\x00-\x1f]/g, "");
  return `${disposition}; filename="${safeName}"`;
}

/**
 * GET /api/v1/vault/documents/:sapDocumentId/content
 *
 * Optional query param `disposition=inline|attachment` overrides the
 * default (browser-viewable MIME types -> inline, everything else ->
 * attachment) — matching the existing DMS split between portal
 * /:id/view (inline) and /:id/download (attachment) semantics.
 */
const handleGetSapDocumentContent = async (req, res) => {
  const tenantId = req.tenant?.id;
  const { sapDocumentId } = req.params;

  try {
    const { document, content, contentLength, mimeType, fileName, checksumSha256 } =
      await getSapDocumentContent({ models: req.models, tenantId, sapDocumentId });

    const requestedDisposition = String(req.query?.disposition || "").toLowerCase();
    const disposition =
      requestedDisposition === "inline" || requestedDisposition === "attachment"
        ? requestedDisposition
        : BROWSER_VIEWABLE_MIME_TYPES.includes(mimeType)
        ? "inline"
        : "attachment";

    structuredLog({
      requestId: req.requestId,
      event: "sap_vault_content_retrieved",
      tenantId,
      route: req.originalUrl,
      status: 200,
    });

    // Best-effort audit trail entry. AuditService.log() never throws —
    // a failure here must never fail the SAP response.
    AuditService.log({
      req,
      tenantId,
      userId: null, // SAP is not a portal user (Requirement 18)
      username: req.sapAuth?.username ? `SAP:${req.sapAuth.username}` : "SAP",
      action: AUDIT_ACTIONS.SAP_RETRIEVAL,
      module: AUDIT_MODULES.DOCUMENT,
      documentId: document.id,
      sapDocumentId: document.sapDocumentId,
      remarks: `SAP Content API retrieved "${fileName}" (${disposition})`,
      status: AUDIT_STATUS.SUCCESS,
    });

    // Requirement 6/7/8: correct Content-Type, correct Content-Length,
    // safe Content-Disposition. Requirement 9/10: no DB credentials or
    // internal storage paths appear anywhere in this response — the
    // body is exactly the stored binary and nothing else.
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(contentLength));
    res.setHeader("Content-Disposition", buildContentDisposition(disposition, fileName));
    // Lets SAP verify the downloaded bytes against the value it can
    // independently recompute, without parsing the response body first.
    // Purely additive — not part of any prior contract, safe for any SAP
    // client that ignores unknown headers.
    if (checksumSha256) {
      res.setHeader("X-Checksum-SHA256", checksumSha256);
    }
    return res.status(200).send(content);
  } catch (error) {
    if (error instanceof SapContentRetrievalError) {
      structuredLog({
        requestId: req.requestId,
        event: "sap_vault_content_rejected",
        tenantId,
        route: req.originalUrl,
        status: error.status,
      });
      return res.status(error.status).json({
        success: false,
        message: error.publicMessage,
      });
    }

    // Never expose internal error details (SQL, stack traces, file
    // paths, credentials) to the SAP caller.
    console.error(
      `[sapContentController] requestId=${req.requestId} tenantId=${tenantId}:`,
      error.message
    );
    structuredLog({
      requestId: req.requestId,
      event: "sap_vault_content_error",
      tenantId,
      route: req.originalUrl,
      status: 500,
    });
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = { handleGetSapDocumentContent };
