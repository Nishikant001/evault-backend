// src/routes/vaultRoutes.js
//
// SAP machine-to-machine Vault API. This router deliberately does NOT
// use authMiddleware, roleMiddleware, or any of subscriptionMiddleware's
// guards (loadSubscription / requireActiveSubscription / requirePaidPlan
// / enforceDailyUploadLimit) — those all assume a JWT-authenticated
// portal user (req.user) exists, which is never true for SAP.
//
// Authentication + tenant resolution for every route in this file is
// handled entirely by sapVaultAuthMiddleware (Basic Auth -> Master DB
// ErpConfig -> Tenant -> tenantConnectionManager). See that file's
// header comment for the full flow.
//
// PHASE 3: document/metadata persistence (DocumentContent write,
// department/category/documentType resolution, idempotent
// create-or-update on sapDocumentId, checksum, etc.) is implemented in
// controllers/vaultController.js + services/vaultUploadService.js.
//
// PHASE 4: document RETRIEVAL (SAP pulling back a binary it previously
// pushed via PHASE 3) is implemented in
// controllers/sapContentController.js + services/sapContentRetrievalService.js.
// It is mounted on THIS router — not a separate app.use() mount point —
// because it needs the exact same sapVaultAuthMiddleware Basic Auth +
// tenant resolution chain as the upload route above; duplicating that
// wiring on a second router would be the one thing this file's header
// comment says never to do.
"use strict";

const express = require("express");
const multer = require("multer");
const router = express.Router();

const sapVaultAuthMiddleware = require("../middleware/sapVaultAuthMiddleware");
const { handleVaultUploadDocument } = require("../controllers/vaultController");
const { handleGetSapDocumentContent } = require("../controllers/sapContentController");
const { MAX_VAULT_FILE_SIZE_BYTES } = require("../constants/vaultUploadConstants");

// multer: memory storage only, matching the confirmed SAP requirement
// of a 50 MB per-file cap. No disk write here, consistent with the rest
// of the paid-tenant upload path. The actual binary/extension/MIME
// validation happens in vaultUploadService.js — multer here is only
// responsible for parsing the multipart request into req.file/req.body.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_VAULT_FILE_SIZE_BYTES,
    // Defense-in-depth against oversized/abusive multipart requests from
    // an authenticated-but-misbehaving caller: this endpoint's contract
    // is exactly one file field plus a small, fixed set of metadata
    // fields (fileName, documentType, department, category,
    // sapDocumentId, tcode, and any ErpConfig.fieldMap-aliased
    // equivalents) — never dozens of arbitrary fields or multi-megabyte
    // field values. These limits are generous headroom above that real
    // shape, not a tight fit, so a legitimate SAP request is never at
    // risk of hitting them.
    fields: 25, // max number of non-file fields
    fieldNameSize: 100, // max bytes per field name
    fieldSize: 10 * 1024, // max bytes per non-file field value
    files: 1, // exactly one file field, matches upload.single("file") below
  },
});

// Wraps multer's single-file parser so a MulterError (oversized file,
// unexpected extra file, wrong field name, ...) becomes the same clean
// JSON shape every other error on this route returns, instead of
// Express's default HTML error page. Deliberately local to this router
// — it does not touch any other route's error handling.
function parseVaultUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          success: false,
          message: "File exceeds the maximum allowed size of 50 MB",
        });
      }
      return res.status(400).json({
        success: false,
        message: `Invalid file upload: ${err.message}`,
      });
    }

    console.error(`[vaultRoutes] requestId=${req.requestId}:`, err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  });
}

// POST /api/v1/vault/documents/upload
// Auth: HTTP Basic (SAP service account), verified against Master DB
// ErpConfig — NOT a portal JWT. Tenant is resolved from those
// credentials only; the request body/query/params are never trusted
// for tenant identity.
router.post(
  "/documents/upload",
  sapVaultAuthMiddleware,
  parseVaultUpload,
  handleVaultUploadDocument
);

// GET /api/v1/vault/documents/:sapDocumentId/content
// Auth: HTTP Basic (SAP service account), verified against Master DB
// ErpConfig — NOT a portal JWT, and NOT subscriptionMiddleware (same
// rule as the upload route above). Tenant is resolved from those
// credentials only; :sapDocumentId is never trusted to imply a tenant —
// the lookup inside sapContentRetrievalService always scopes by the
// tenant sapVaultAuthMiddleware resolved, so a valid SAP credential for
// Tenant A can never retrieve a document that belongs to Tenant B.
router.get(
  "/documents/:sapDocumentId/content",
  sapVaultAuthMiddleware,
  handleGetSapDocumentContent
);

module.exports = router;
