// src/constants/vaultUploadConstants.js
//
// Allow-lists and limits for the SAP Content API document upload endpoint
// (POST /api/v1/vault/documents/upload — see vaultUploadService.js).
//
// Kept in its own constants file (rather than reusing
// documentContentService.MAX_DOCUMENT_SIZE_BYTES alone) because this list
// is specific to the CONFIRMED SAP CONTRACT for this one endpoint and must
// not silently drift if some other upload path's allow-list changes later.
"use strict";

// Confirmed SAP contract: 50 MB per file. Mirrors
// documentContentService.MAX_DOCUMENT_SIZE_BYTES and the multer limit
// configured in routes/vaultRoutes.js — all three must stay in sync.
const MAX_VAULT_FILE_SIZE_BYTES = 50 * 1024 * 1024;

// Confirmed SAP contract: PDF, TIFF, PNG, JPG, DOCX, XLSX, ZIP.
// Each extension maps to the ONLY MIME type(s) accepted for it — this is
// intentionally a strict per-extension map (not a flat "any of these
// MIME types is fine anywhere" list) so a file can't pass validation by
// pairing an allowed extension with an unrelated allowed MIME type.
const EXTENSION_MIME_MAP = {
  ".pdf": ["application/pdf"],
  ".tif": ["image/tiff"],
  ".tiff": ["image/tiff"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ".xlsx": [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  // application/octet-stream is tolerated for .zip ONLY: many SAP/HTTP
  // client stacks report generic zip archives this way. Every other
  // extension above requires its exact MIME type — no octet-stream
  // fallback for PDF/image/Office types.
  ".zip": ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
};

const ALLOWED_EXTENSIONS = Object.keys(EXTENSION_MIME_MAP);

// Best-effort magic-byte (file signature) check, defense-in-depth against
// a renamed/relabeled file (e.g. a script saved as "invoice.pdf"). DOCX
// and XLSX are themselves ZIP (OOXML) containers, so they share the ZIP
// signature — this check can confirm "this is a real ZIP-family
// container" for those two but cannot (without fully parsing the
// package) distinguish a .docx from a plain .zip renamed to .docx. That
// deeper check is intentionally out of scope here; extension + MIME
// type + this signature check together are the layers this endpoint
// applies.
const MAGIC_BYTE_SIGNATURES = {
  ".pdf": [[0x25, 0x50, 0x44, 0x46]], // %PDF
  ".png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ".jpg": [[0xff, 0xd8, 0xff]],
  ".jpeg": [[0xff, 0xd8, 0xff]],
  ".tif": [
    [0x49, 0x49, 0x2a, 0x00], // little-endian TIFF
    [0x4d, 0x4d, 0x00, 0x2a], // big-endian TIFF
  ],
  ".tiff": [
    [0x49, 0x49, 0x2a, 0x00],
    [0x4d, 0x4d, 0x00, 0x2a],
  ],
  ".zip": [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
  ],
  ".docx": [[0x50, 0x4b, 0x03, 0x04]],
  ".xlsx": [[0x50, 0x4b, 0x03, 0x04]],
};

const VAULT_SOURCE_TYPE = "SAP_CONTENT_API";

// Used by the SAP Content API retrieval endpoint
// (GET /api/v1/vault/documents/:sapDocumentId/content — see
// services/sapContentRetrievalService.js) to decide default
// Content-Disposition semantics: browser-renderable types default to
// "inline" (matches the existing portal /:id/view behavior), everything
// else defaults to "attachment" (matches the existing portal
// /:id/download behavior). This is only ever a DEFAULT — the caller can
// still override it with ?disposition=inline|attachment.
const BROWSER_VIEWABLE_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
];

module.exports = {
  MAX_VAULT_FILE_SIZE_BYTES,
  EXTENSION_MIME_MAP,
  ALLOWED_EXTENSIONS,
  MAGIC_BYTE_SIGNATURES,
  VAULT_SOURCE_TYPE,
  BROWSER_VIEWABLE_MIME_TYPES,
};
