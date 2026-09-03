// src/services/documentContentService.js
//
// Generic database-backed document binary storage.
//
// This service is intentionally NOT SAP-specific.
// It can be used later by the SAP Content API without coupling
// storage logic to OData/authentication details.

const crypto = require("crypto");

const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

function validateBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("Document content must be provided as a Buffer");
  }

  if (buffer.length === 0) {
    throw new Error("Document content cannot be empty");
  }

  if (buffer.length > MAX_DOCUMENT_SIZE_BYTES) {
    throw new Error("Document exceeds the maximum allowed size of 50 MB");
  }
}

function calculateSha256(buffer) {
  return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");
}

/**
 * Store or replace binary content for a document.
 *
 * @param {Object} params
 * @param {Object} params.models - tenant model factory result
 * @param {number} params.documentId
 * @param {Buffer} params.buffer
 * @param {Object} [params.transaction]
 * @returns {Promise<Object>}
 */
async function storeDocumentContent({
  models,
  documentId,
  buffer,
  transaction = undefined,
}) {
  if (!models || !models.DocumentContent) {
    throw new Error("DocumentContent model is not available");
  }

  if (!Number.isInteger(Number(documentId)) || Number(documentId) <= 0) {
    throw new Error("documentId is required");
  }

  validateBuffer(buffer);

  const checksumSha256 = calculateSha256(buffer);

  const existing = await models.DocumentContent.findOne({
    where: { documentId },
    transaction,
  });

  if (existing) {
    await existing.update(
      {
        content: buffer,
        contentLength: buffer.length,
        checksumSha256,
      },
      { transaction }
    );

    return existing;
  }

  return models.DocumentContent.create(
    {
      documentId,
      content: buffer,
      contentLength: buffer.length,
      checksumSha256,
    },
    { transaction }
  );
}

/**
 * Retrieve binary content for a document.
 *
 * @param {Object} params
 * @param {Object} params.models - tenant model factory result
 * @param {number} params.documentId
 * @param {Object} [params.transaction]
 * @returns {Promise<Object|null>}
 */
async function getDocumentContent({
  models,
  documentId,
  transaction = undefined,
}) {
  if (!models || !models.DocumentContent) {
    throw new Error("DocumentContent model is not available");
  }

  if (!Number.isInteger(Number(documentId)) || Number(documentId) <= 0) {
    throw new Error("documentId is required");
  }

  return models.DocumentContent.findOne({
    where: { documentId },
    transaction,
  });
}

/**
 * Delete binary content for a document.
 *
 * This is provided for future document lifecycle operations.
 * The Document -> DocumentContent foreign-key cascade also protects
 * against orphaned content when a document is physically deleted.
 *
 * @param {Object} params
 * @param {Object} params.models
 * @param {number} params.documentId
 * @param {Object} [params.transaction]
 * @returns {Promise<number>}
 */
async function deleteDocumentContent({
  models,
  documentId,
  transaction = undefined,
}) {
  if (!models || !models.DocumentContent) {
    throw new Error("DocumentContent model is not available");
  }

  if (!Number.isInteger(Number(documentId)) || Number(documentId) <= 0) {
    throw new Error("documentId is required");
  }

  return models.DocumentContent.destroy({
    where: { documentId },
    transaction,
  });
}

module.exports = {
  MAX_DOCUMENT_SIZE_BYTES,
  calculateSha256,
  storeDocumentContent,
  getDocumentContent,
  deleteDocumentContent,
};