// src/services/vaultUploadService.js
//
// PHASE 3 — SAP Content API document persistence.
//
// This is the business-logic layer behind
// POST /api/v1/vault/documents/upload (see routes/vaultRoutes.js and
// controllers/vaultController.js). By the time anything in this file
// runs, sapVaultAuthMiddleware has already:
//   - authenticated SAP (Basic Auth against Master DB ErpConfig),
//   - resolved exactly one tenant, and
//   - opened that tenant's Sequelize connection (req.models).
//
// Nothing here re-authenticates, re-resolves a tenant, or accepts a
// tenantId/tenant identifier from the request body — tenantId is always
// the one the middleware already resolved.
//
// This module deliberately does NOT call SapService / ErpFactory / any
// SAP Content Server client. SAP is the CALLER for this storage mode; the
// binary already lives in the request body. Calling back out to SAP here
// would be exactly the SAP_SYNC/local-upload behavior this new storage
// mode must NOT reproduce (Requirement 20).
"use strict";

const path = require("path");

const documentContentService = require("./documentContentService");
// PHASE — SAP Content API integration: reuse the SAME dynamic field
// resolver the OData sync uses (see sapSyncFieldMap.js /
// sapEntityResolver.js) instead of reading req.body.fileName etc.
// directly. mapDocumentMeta() already understands sapDocumentId,
// fileName, departmentCode, categoryCode, documentTypeCode, and (as of
// this integration) tcode — including per-tenant ErpConfig.fieldMap
// overrides — so a different SAP landscape that posts these fields
// under different key names only needs a fieldMap entry, not a code
// change here.
const { mapDocumentMeta } = require("./sapSyncFieldMap");
const {
  MAX_VAULT_FILE_SIZE_BYTES,
  EXTENSION_MIME_MAP,
  MAGIC_BYTE_SIGNATURES,
  VAULT_SOURCE_TYPE,
} = require("../constants/vaultUploadConstants");

/**
 * Thrown for every expected/validated failure in this module. The
 * controller maps `status` straight onto the HTTP response and returns
 * `publicMessage` verbatim — both are always safe to show to SAP (no
 * SQL, no file paths, no internal identifiers beyond what SAP itself
 * sent us).
 */
class VaultUploadError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.name = "VaultUploadError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/**
 * Rejects dangerous/path-traversal filenames and returns a clean
 * basename. Never trusts the caller-declared name for anything except
 * display/storage as a plain string column value — it is NEVER used to
 * build a filesystem path (this endpoint stores binaries in the
 * database only, see documentContentService).
 */
function sanitizeFileName(rawFileName) {
  const fileName = String(rawFileName || "").trim();

  if (!fileName) {
    throw new VaultUploadError(400, "fileName is required");
  }

  if (fileName.length > 255) {
    throw new VaultUploadError(400, "fileName exceeds the maximum length of 255 characters");
  }

  // Reject control characters (including null bytes) outright.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(fileName)) {
    throw new VaultUploadError(400, "fileName contains invalid control characters");
  }

  // Reject any path separator explicitly. path.basename() alone is not
  // enough here: on a POSIX host it only treats "/" as a separator, so a
  // Windows-style "a\\..\\b.pdf" would pass straight through untouched.
  if (fileName.includes("/") || fileName.includes("\\")) {
    throw new VaultUploadError(400, "fileName must not contain path separators");
  }

  // path.basename() also strips a leading drive letter / any remaining
  // directory component for the platform's own separator convention.
  // If the result still differs from the input after the explicit
  // separator check above, reject rather than silently truncate.
  const base = path.basename(fileName);
  if (base !== fileName) {
    throw new VaultUploadError(400, "fileName must not contain path separators");
  }

  if (base === "." || base === ".." || base.includes("..")) {
    throw new VaultUploadError(400, "fileName is not a valid file name");
  }

  return base;
}

/**
 * Validates that the file's extension is on the confirmed SAP allow-list,
 * that the declared MIME type is the one (and only one) MIME type
 * accepted for that extension, and — as defense-in-depth — that the
 * binary's own leading bytes match a known signature for that extension.
 */
function validateExtensionAndMime(safeFileName, mimeType, buffer) {
  const ext = path.extname(safeFileName).toLowerCase();
  const acceptedMimeTypes = EXTENSION_MIME_MAP[ext];

  if (!acceptedMimeTypes) {
    throw new VaultUploadError(
      415,
      `File extension "${ext || "(none)"}" is not allowed. Allowed types: PDF, TIFF, PNG, JPG, DOCX, XLSX, ZIP.`
    );
  }

  const normalizedMime = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (!acceptedMimeTypes.includes(normalizedMime)) {
    throw new VaultUploadError(
      415,
      `MIME type "${mimeType || "(none)"}" does not match the expected type for a "${ext}" file`
    );
  }

  const signatures = MAGIC_BYTE_SIGNATURES[ext];
  if (signatures && signatures.length) {
    const matches = signatures.some((sig) =>
      sig.every((byte, index) => buffer[index] === byte)
    );
    if (!matches) {
      throw new VaultUploadError(
        415,
        `File content does not match the expected format for a "${ext}" file`
      );
    }
  }

  return ext;
}

function validateSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new VaultUploadError(400, "Uploaded file is empty");
  }
  if (buffer.length > MAX_VAULT_FILE_SIZE_BYTES) {
    throw new VaultUploadError(413, "File exceeds the maximum allowed size of 50 MB");
  }
}

function requireNonBlank(value, fieldName) {
  const str = value === undefined || value === null ? "" : String(value).trim();
  if (!str) {
    throw new VaultUploadError(400, `${fieldName} is required`);
  }
  return str;
}

/**
 * Validates the multipart file + required metadata for
 * POST /api/v1/vault/documents/upload. Throws VaultUploadError on any
 * violation. Returns the normalized { fileName, documentType, department,
 * category, sapDocumentId, tcode, ext } values to use downstream.
 *
 * Metadata field NAMES are resolved dynamically via
 * sapSyncFieldMap.mapDocumentMeta() (the same DOCUMENT_META logical-field
 * table + ErpConfig.fieldMap override chain the existing OData
 * DocumentMetaSet sync uses) rather than reading req.body.fileName etc.
 * literally — see constants/sapSyncConstants.js's DOCUMENT_META entry.
 *
 * @param {Object} params
 * @param {Object} params.file
 * @param {Object} params.body
 * @param {Object} [params.erpConfig] - req.erpConfig (this SAP landscape's
 *   ErpConfig row), enabling per-tenant fieldMap overrides. Omitting it
 *   falls back to the legacy/default candidate lists only.
 */
function validateRequest({ file, body, erpConfig }) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new VaultUploadError(400, "A file is required (multipart field name: \"file\")");
  }

  validateSize(file.buffer);

  const mapped = mapDocumentMeta(body, erpConfig);

  const fileName = requireNonBlank(mapped.fileName, "fileName");
  const documentType = requireNonBlank(mapped.documentTypeCode, "documentType");
  const department = requireNonBlank(mapped.departmentCode, "department");
  const category = requireNonBlank(mapped.categoryCode, "category");
  const sapDocumentId = requireNonBlank(mapped.sapDocumentId, "sapDocumentId");
  const tcode = requireNonBlank(mapped.tcode, "tcode");

  const safeFileName = sanitizeFileName(fileName);
  const ext = validateExtensionAndMime(safeFileName, file.mimetype, file.buffer);

  return { safeFileName, documentType, department, category, sapDocumentId, tcode, ext };
}

/**
 * Persists one SAP Content API upload: resolves department/category/
 * documentType via the SAME lookup the SAP Document Synchronization
 * engine uses (sapDocumentSyncService.resolveClassification — pure DB
 * lookup, no SAP call), then creates or idempotently updates the
 * Document + DocumentContent rows inside a single transaction.
 *
 * @param {Object} params
 * @param {Object} params.models       - req.models (this tenant's Sequelize models)
 * @param {Object} params.masterModels - req.masterModels
 * @param {number} params.tenantId     - req.tenant.id
 * @param {Object} params.file         - req.file (multer memory storage)
 * @param {Object} params.body         - req.body
 * @param {Object} [params.erpConfig]  - req.erpConfig (this SAP landscape's
 *   ErpConfig row), used only to resolve per-tenant metadata field-name
 *   overrides (see validateRequest above). Never used to call out to SAP.
 * @returns {Promise<{ httpStatus: number, action: "created"|"updated", document: Object }>}
 */
async function uploadSapDocument({ models, masterModels, tenantId, file, body, erpConfig }) {
  const { safeFileName, documentType, department, category, sapDocumentId, tcode } =
    validateRequest({ file, body, erpConfig });

  const buffer = file.buffer;
  const mimeType = String(file.mimetype || "").split(";")[0].trim().toLowerCase();

  // Classification ownership is intentionally explicit for this endpoint:
  // Department -> MASTER DB; Category/DocumentType -> THIS TENANT DB.
  // Direct model queries are used because these models live on different
  // Sequelize connections and must never be joined cross-database.
  const MasterDepartment = masterModels?.Department;
  const TenantCategory = models?.Category;
  const TenantDocumentType = models?.DocumentType;

  if (!MasterDepartment || !TenantCategory || !TenantDocumentType) {
    throw new VaultUploadError(500, "Internal server error");
  }

  const [departmentRecord, categoryRecord, documentTypeRecord] = await Promise.all([
    MasterDepartment.findOne({ where: { sapCode: department } }),
    TenantCategory.findOne({ where: { tenantId, sapCode: category } }),
    TenantDocumentType.findOne({ where: { tenantId, sapCode: documentType } }),
  ]);

  const unresolved = [];
  if (!departmentRecord) unresolved.push("department");
  if (!categoryRecord) unresolved.push("category");
  if (!documentTypeRecord) unresolved.push("documentType");

  if (unresolved.length) {
    throw new VaultUploadError(
      422,
      `${unresolved.join(", ")} must match existing master data (sapCode) for this tenant.`
    );
  }

  const departmentId = departmentRecord.id;
  const categoryId = categoryRecord.id;
  const documentTypeId = documentTypeRecord.id;

  const { Document } = models;
  if (!Document) {
    throw new VaultUploadError(500, "Internal server error");
  }

  try {
    return await Document.sequelize.transaction(async (transaction) => {
      // Idempotency: sapDocumentId is the SAP-side identifier and is
      // unique on Document. Lock the row (if any) for the duration of
      // this transaction so two concurrent uploads for the same
      // sapDocumentId can't race each other into duplicate rows.
      const existing = await Document.findOne({
        where: { sapDocumentId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      let documentRecord;
      let action;
      let httpStatus;

      if (existing) {
        // Safe, explicit idempotency behavior: only ever replace content
        // for a document that already belongs to THIS storage mode. A
        // sapDocumentId that already exists under a different
        // sourceType (e.g. SAP_SYNC) is a real conflict — refuse rather
        // than silently overwriting a record this endpoint doesn't own.
        if (existing.sourceType !== VAULT_SOURCE_TYPE) {
          throw new VaultUploadError(
            409,
            `sapDocumentId "${sapDocumentId}" already exists with sourceType "${existing.sourceType}"; ` +
              "the SAP Content API cannot overwrite a document it did not create."
          );
        }

        await existing.update(
          {
            originalFileName: safeFileName,
            mimeType,
            fileSizeBytes: buffer.length,
            departmentId,
            categoryId,
            documentTypeId,
            tcode,
            sourceType: VAULT_SOURCE_TYPE,
            uploadStatus: "COMPLETED",
          },
          { transaction }
        );

        documentRecord = existing;
        action = "updated";
        httpStatus = 200;
      } else {
        documentRecord = await Document.create(
          {
            tenantId,
            departmentId,
            categoryId,
            documentTypeId,
            uploadedBy: null, // SAP is not a portal user (Requirement 18)
            originalFileName: safeFileName,
            mimeType,
            fileSizeBytes: buffer.length,
            sapDocumentId,
            tcode,
            sourceType: VAULT_SOURCE_TYPE,
            uploadStatus: "COMPLETED",
            status: "ACTIVE",
          },
          { transaction }
        );

        action = "created";
        httpStatus = 201;
      }

      // Binary + size + SHA-256 checksum, all computed/stored by the
      // existing generic content service — never loaded from/to disk.
      const contentRecord = await documentContentService.storeDocumentContent({
        models,
        documentId: documentRecord.id,
        buffer,
        transaction,
      });

      // Surface the server-computed checksum back to the caller (SAP) so
      // it can verify the bytes we stored match what it sent, without SAP
      // having to separately GET the content back. Computed exclusively
      // by documentContentService — never trusts/accepts a caller-supplied
      // checksum for this value.
      return {
        httpStatus,
        action,
        document: documentRecord,
        checksumSha256: contentRecord.checksumSha256,
      };
    });
  } catch (error) {
    if (error instanceof VaultUploadError) throw error;

    // A unique-constraint hit (sapDocumentId race, or tcode already used
    // by a different document — tcode is also unique on Document) is an
    // expected, client-fixable conflict, not a server error.
    if (error.name === "SequelizeUniqueConstraintError") {
      const field = error.errors?.[0]?.path || "field";
      throw new VaultUploadError(
        409,
        `A document with this ${field} already exists and cannot be created again.`
      );
    }

    throw error;
  }
}

module.exports = {
  VaultUploadError,
  uploadSapDocument,
  // exported for unit testing
  sanitizeFileName,
  validateExtensionAndMime,
};
