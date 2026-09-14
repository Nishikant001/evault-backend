// src/services/sapContentRetrievalService.js
//
// PHASE 4 — SAP Content API document RETRIEVAL.
//
// This is the read-side counterpart to vaultUploadService.js
// (POST /api/v1/vault/documents/upload). By the time anything in this
// file runs, sapVaultAuthMiddleware has already:
//   - authenticated SAP (Basic Auth against Master DB ErpConfig),
//   - resolved exactly one tenant, and
//   - opened that tenant's Sequelize connection (req.models).
//
// tenantId is always the one the middleware already resolved — nothing
// here re-authenticates, re-resolves a tenant, or accepts a tenantId /
// tenant identifier from the request itself (Requirements 1, 2, 11).
//
// This module does NOT read or write BLOB columns directly. All binary
// I/O is delegated to documentContentService.getDocumentContent — the
// SAME generic, non-SAP-specific service vaultUploadService.js already
// uses to write content on upload (Requirement: "reuse existing
// document content service, do not duplicate binary-storage logic").
"use strict";

const documentContentService = require("./documentContentService");
const { VAULT_SOURCE_TYPE } = require("../constants/vaultUploadConstants");

/**
 * Thrown for every expected/validated failure in this module. The
 * controller maps `status` straight onto the HTTP response and returns
 * `publicMessage` verbatim — both are always safe to show to SAP (no
 * SQL, no file paths, no internal database identifiers).
 */
class SapContentRetrievalError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.name = "SapContentRetrievalError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/**
 * Resolve a Document by SAP's own identifier and load its stored
 * binary, scoped entirely to the tenant sapVaultAuthMiddleware already
 * resolved for this request (Requirement 11 — cross-tenant access is
 * structurally impossible here: the WHERE clause always includes
 * tenantId, and tenantId is never taken from params/query/body).
 *
 * @param {Object} params
 * @param {Object} params.models   - req.models (this tenant's Sequelize models)
 * @param {number} params.tenantId - req.tenant.id
 * @param {string} params.sapDocumentId - route param, SAP's own document identifier
 * @returns {Promise<{ document: Object, content: Buffer, contentLength: number, mimeType: string, fileName: string }>}
 */
async function getSapDocumentContent({ models, tenantId, sapDocumentId }) {
  const { Document } = models || {};
  if (!Document) {
    throw new SapContentRetrievalError(500, "Internal server error");
  }

  const cleanSapDocumentId = String(sapDocumentId || "").trim();
  if (!cleanSapDocumentId) {
    throw new SapContentRetrievalError(400, "sapDocumentId is required");
  }

  // Requirement 3 + 12: look the document up by sapDocumentId, scoped to
  // this tenant and to non-deleted rows. Any miss (wrong tenant, wrong
  // id, soft-deleted) returns the same generic 404 — never distinguishes
  // "exists in another tenant" from "does not exist" (Requirement 11).
  const document = await Document.findOne({
    where: {
      sapDocumentId: cleanSapDocumentId,
      tenantId,
      status: "ACTIVE",
    },
  });

  if (!document) {
    throw new SapContentRetrievalError(404, "Document not found");
  }

  // Requirement 4: only documents whose binary was actually written into
  // DocumentContent by THIS storage mode are servable here. A
  // SAP_SYNC document's binary lives on the SAP Content Server, not in
  // our DocumentContent table — this endpoint deliberately does not call
  // out to SAP (that is the existing /:id/view and /:id/download job,
  // left untouched). Treat a source-type mismatch the same as "not
  // found" rather than leaking which sourceType the sapDocumentId
  // belongs to.
  if (document.sourceType !== VAULT_SOURCE_TYPE) {
    throw new SapContentRetrievalError(404, "Document not found");
  }

  const contentRow = await documentContentService.getDocumentContent({
    models,
    documentId: document.id,
  });

  if (!contentRow) {
    // Metadata row exists but the binary is missing — an inconsistent
    // state that should never happen (upload is transactional), but
    // fail closed with 404 rather than a 500 that might imply a server
    // bug SAP should retry indefinitely.
    throw new SapContentRetrievalError(404, "Document content not found");
  }

  return {
    document,
    content: contentRow.content,
    contentLength: Number(contentRow.contentLength),
    mimeType: document.mimeType || "application/octet-stream",
    fileName: document.originalFileName || "document",
    // Server-computed at upload time (documentContentService, SHA-256).
    // Exposed so SAP can verify the downloaded bytes match what it
    // originally pushed, without trusting anything client-supplied.
    checksumSha256: contentRow.checksumSha256,
  };
}

module.exports = {
  SapContentRetrievalError,
  getSapDocumentContent,
};
