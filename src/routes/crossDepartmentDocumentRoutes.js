"use strict";

const express = require("express");

const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const { requireTenantModule } = require("../middleware/tenantModuleMiddleware");

const {
  createRequest,
  listRequests,
  getRequest,
  searchSourceDocuments,
  selectDocument,
  prepareShare,
  maskShare,
  sendShare,
  viewShare,
  downloadShare,
  revokeShare,
  rejectRequest,
} = require("../controllers/crossDepartmentDocumentController");

// ============================================================
// AUTHENTICATION
// ============================================================

router.use(authMiddleware, requireTenantModule("cross_department"));


// ============================================================
// REQUESTER / OWNER
// ============================================================

// Create document access request
//
// POST /api/cross-department-documents/cross-department-requests
//
// Body:
// {
//   requestedDepartmentId,
//   documentReference,
//   reason
// }
//
// IMPORTANT:
// No file.
// No sourceDocumentId.
// No ownerUserId.
router.post(
  "/cross-department-requests",
  createRequest
);


// List requests visible to current user
//
// GET /api/cross-department-documents/cross-department-requests
router.get(
  "/cross-department-requests",
  listRequests
);


// Get single request
//
// GET /api/cross-department-documents/cross-department-requests/:id
router.get(
  "/cross-department-requests/:id",
  getRequest
);


// ============================================================
// OWNER — EXISTING DMS SEARCH
// ============================================================

// Search existing DMS documents.
//
// IMPORTANT:
// Only the authorized owner/handler should be able to use this.
// The controller/service performs authorization.
//
// GET
// /api/cross-department-documents/
// cross-department-requests/:id/source-documents
//
// Query:
// ?q=PO-2026-0045
router.get(
  "/cross-department-requests/:id/source-documents",
  searchSourceDocuments
);


// ============================================================
// OWNER — SELECT EXISTING DOCUMENT
// ============================================================

// Select an existing DMS document.
//
// POST
// /api/cross-department-documents/
// cross-department-requests/:id/select-document
//
// Body:
// {
//   sourceDocumentId,
//   sourceDocumentVersion
// }
//
// NO upload.
router.post(
  "/cross-department-requests/:id/select-document",
  selectDocument
);


// ============================================================
// OWNER — PREPARE TEMPORARY SHARE
// ============================================================

// POST
// /api/cross-department-documents/
// cross-department-requests/:id/prepare
//
// Body:
// {
//   durationMinutes: 60,
//   maskingRequired: false
// }
router.post(
  "/cross-department-requests/:id/prepare",
  prepareShare
);


// ============================================================
// OWNER — MASK TEMPORARY COPY
// ============================================================

// POST
// /api/cross-department-documents/
// cross-department-shares/:id/mask
//
// Body:
// {
//   masks: [
//     {
//       page,
//       x,
//       y,
//       width,
//       height
//     }
//   ]
// }
//
// Also supports annotations/points as defined by the service.
router.post(
  "/cross-department-shares/:id/mask",
  maskShare
);


// ============================================================
// OWNER — SEND TEMPORARY COPY
// ============================================================

// POST
// /api/cross-department-documents/
// cross-department-shares/:id/send
router.post(
  "/cross-department-shares/:id/send",
  sendShare
);


// ============================================================
// RECIPIENT — VIEW
// ============================================================

// GET
// /api/cross-department-documents/
// cross-department-shares/:id/view
//
// IMPORTANT:
// Uses shareId only.
// Never uses original document endpoint.
router.get(
  "/cross-department-shares/:id/view",
  viewShare
);


// ============================================================
// RECIPIENT — DOWNLOAD
// ============================================================

// GET
// /api/cross-department-documents/
// cross-department-shares/:id/download
//
// IMPORTANT:
// Uses shareId only.
router.get(
  "/cross-department-shares/:id/download",
  downloadShare
);


// ============================================================
// OWNER — REVOKE
// ============================================================

// POST
// /api/cross-department-documents/
// cross-department-shares/:id/revoke
//
// Body:
// {
//   reason: "Access no longer required"
// }
router.post(
  "/cross-department-shares/:id/revoke",
  revokeShare
);


// ============================================================
// OWNER — REJECT REQUEST
// ============================================================

// POST
// /api/cross-department-documents/
// cross-department-requests/:id/reject
//
// Body:
// {
//   reason: "Document cannot be shared"
// }
router.post(
  "/cross-department-requests/:id/reject",
  rejectRequest
);


module.exports = router;