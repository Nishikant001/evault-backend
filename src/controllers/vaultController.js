// src/controllers/vaultController.js
//
// PHASE 3 — SAP Content API document persistence.
//
// req.tenant / req.models / req.masterModels / req.sapAuth are set
// EXCLUSIVELY by sapVaultAuthMiddleware — nothing in this controller
// resolves tenant identity, authenticates SAP, or reads a tenant
// identifier from the request itself. This controller's only job is:
// validate the multipart request, hand it to vaultUploadService, and
// translate the result into the clean SAP-friendly JSON response
// documented on the route.
//
// This file does NOT touch documentController.js's existing
// LOCAL_UPLOAD flow, or sapDocumentSyncService.js's existing SAP_SYNC
// flow — it only adds a new, separate code path for sourceType =
// SAP_CONTENT_API.
"use strict";

const { VaultUploadError, uploadSapDocument } = require("../services/vaultUploadService");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES } = require("../constants/auditActions");
const { structuredLog } = require("../middleware/requestContextMiddleware");

const handleVaultUploadDocument = async (req, res) => {
  const tenantId = req.tenant?.id;

  try {
    const { httpStatus, action, document, checksumSha256 } = await uploadSapDocument({
      models: req.models,
      masterModels: req.masterModels,
      tenantId,
      file: req.file,
      body: req.body,
      // PHASE — SAP Content API integration: lets vaultUploadService
      // resolve metadata field names via this landscape's
      // ErpConfig.fieldMap, same dynamic architecture as the OData sync.
      erpConfig: req.erpConfig,
    });

    structuredLog({
      requestId: req.requestId,
      event: action === "created" ? "sap_vault_document_created" : "sap_vault_document_updated",
      tenantId,
      route: req.originalUrl,
      status: httpStatus,
    });

    // Best-effort audit trail entry. AuditService.log() never throws —
    // a failure here must never fail the SAP response.
    AuditService.log({
      req,
      tenantId,
      userId: null, // SAP is not a portal user (Requirement 18)
      username: req.sapAuth?.username ? `SAP:${req.sapAuth.username}` : "SAP",
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD,
      module: AUDIT_MODULES.DOCUMENT,
      documentId: document.id,
      sapDocumentId: document.sapDocumentId,
      remarks: `SAP Content API ${action} via tcode ${document.tcode}`,
    });

    return res.status(httpStatus).json({
      success: true,
      documentId: document.id,
      sapDocumentId: document.sapDocumentId,
      fileName: document.originalFileName,
      tcode: document.tcode,
      checksumSha256,
      message:
        action === "created"
          ? "Document uploaded and stored successfully."
          : "Existing document's content and metadata were updated successfully.",
    });
  } catch (error) {
    if (error instanceof VaultUploadError) {
      structuredLog({
        requestId: req.requestId,
        event: "sap_vault_upload_rejected",
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
    console.error(`[vaultController] requestId=${req.requestId} tenantId=${tenantId}:`, error.message);
    structuredLog({
      requestId: req.requestId,
      event: "sap_vault_upload_error",
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

module.exports = { handleVaultUploadDocument };
