// src/controllers/crossDepartmentDocumentController.js
//
// Cross-Department Document Request Controller
//
// IMPORTANT BUSINESS RULES:
//
// 1. Requester only specifies:
//      - requested department
//      - document reference/search hint
//      - reason
//
// 2. Requester NEVER uploads a document.
//
// 3. Requester NEVER selects sourceDocumentId.
//
// 4. Only an authorized user of the requested department can:
//      - view the request
//      - search/select an existing DMS document
//      - approve/reject
//      - prepare/send
//      - revoke the temporary share
//
// 5. sourceDocumentId MUST always point to an existing DMS document.
//
// 6. Temporary view/download uses shareId, NOT /documents/:id/view
//    or /documents/:id/download.
//
// 7. Every operation is tenant-scoped.
//
// 8. The service layer owns the actual business logic, storage,
//    SAP retrieval, masking and cleanup.

const crossDepartmentDocumentService = require("../services/crossDepartmentDocumentService");


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const getTenantId = (req) => {
  const tenantId = req.user?.tenantId;

  if (!tenantId) {
    const error = new Error("Tenant context is required");
    error.statusCode = 401;
    throw error;
  }

  return Number(tenantId);
};


const getUserId = (req) => {
  const userId = req.user?.id;

  if (!userId) {
    const error = new Error("Authenticated user is required");
    error.statusCode = 401;
    throw error;
  }

  return Number(userId);
};


const sendError = (res, error) => {
  console.error(
    "[CrossDepartmentDocumentController]",
    error
  );

  const status =
    Number(error.statusCode) ||
    Number(error.status) ||
    500;

  return res.status(status).json({
    success: false,
    message: error.message || "Internal server error",
  });
};


// ─────────────────────────────────────────────────────────────
// STEP 1
// Requester creates cross-department document request
//
// POST /api/cross-department-requests
//
// Body:
//
// {
//   requestedDepartmentId: 5,
//   documentReference: "PO-2026-0045",
//   reason: "Required for verification"
// }
//
// IMPORTANT:
// sourceDocumentId is intentionally NOT accepted here.
// ownerUserId is intentionally NOT accepted here.
// file/upload is intentionally NOT accepted here.
// ─────────────────────────────────────────────────────────────

const createRequest = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const requesterUserId = getUserId(req);

    const {
      requestedDepartmentId,
      documentReference,
      reason,
    } = req.body || {};

    if (!requestedDepartmentId) {
      return res.status(400).json({
        success: false,
        message: "requestedDepartmentId is required",
      });
    }

    if (!documentReference || !String(documentReference).trim()) {
      return res.status(400).json({
        success: false,
        message: "documentReference is required",
      });
    }

    // The requester's own department is optional context only — the
    // whole point of this feature is requesting a document from a
    // department the requester does NOT belong to, so it is never
    // required for the request to be created.
    const requesterDepartmentId =
      req.user?.departmentId ||
      req.user?.department?.id ||
      null;

    const result =
      await crossDepartmentDocumentService.createRequest(req, {
        tenantId,
        requesterUserId,
        requesterDepartmentId: requesterDepartmentId
          ? Number(requesterDepartmentId)
          : null,
        requestedDepartmentId: Number(requestedDepartmentId),
        documentReference: String(documentReference).trim(),
        reason: reason ? String(reason).trim() : null,
      });

    return res.status(201).json({
      success: true,
      message: "Document access request created successfully",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 2
// List requests visible to current user
//
// GET /api/cross-department-requests
//
// Requester sees their own requests.
// Authorized department owner/admin sees requests routed to them.
// ─────────────────────────────────────────────────────────────

const listRequests = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);

    const result =
      await crossDepartmentDocumentService.listRequests(req, {
        status: req.query?.status,
        mine: req.query?.mine === "true" || req.query?.mine === true,
        requestedDepartmentId: req.query?.requestedDepartmentId,
      });

    return res.json({
      success: true,
      data: Array.isArray(result) ? result : result.data || [],
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 3
// Get single request
//
// GET /api/cross-department-requests/:id
//
// Service MUST perform authorization.
// Do not expose a request merely because the numeric ID exists.
// ─────────────────────────────────────────────────────────────

const getRequest = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);
    const requestId = Number(req.params.id);

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid request id",
      });
    }

    const result =
      await crossDepartmentDocumentService.getRequest(req, requestId);

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 4
// Owner searches existing DMS documents
//
// IMPORTANT:
//
// The requester MUST NOT be allowed to use this endpoint.
//
// This endpoint is ONLY for the authorized owner/handler.
//
// The actual search must reuse the existing DMS search engine.
//
// NO upload is accepted.
//
// POST/GET body/query can contain search text only.
// ─────────────────────────────────────────────────────────────

const searchSourceDocuments = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);

    const requestId = Number(req.params.id);

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid request id",
      });
    }

    const query =
      req.query?.q ||
      req.query?.search ||
      req.query?.documentReference ||
      "";

    const page = req.query?.page || 1;
    const limit = req.query?.limit || 20;

    const result =
      await crossDepartmentDocumentService.searchSourceDocuments(req, {
        requestId,
        query: String(query).trim(),
        page,
        limit,
      });

    return res.json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 5
// Owner selects existing DMS document
//
// POST /api/cross-department-requests/:id/select-document
//
// Body:
//
// {
//   sourceDocumentId: 123,
//   sourceDocumentVersion: 2
// }
//
// IMPORTANT:
//
// This endpoint does NOT upload anything.
//
// It only links the request to an existing DMS Document.
//
// The service MUST verify that:
//
// - document belongs to same tenant
// - document is ACTIVE
// - owner is authorized
// - document belongs to requested department
// - document is actually accessible to owner
// - version is valid if versioning is supported
// ─────────────────────────────────────────────────────────────

const selectDocument = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);

    const requestId = Number(req.params.id);

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid request id",
      });
    }

    const {
      sourceDocumentId,
      sourceDocumentVersion,
    } = req.body || {};

    if (!sourceDocumentId) {
      return res.status(400).json({
        success: false,
        message: "sourceDocumentId is required",
      });
    }

    const result =
      await crossDepartmentDocumentService.selectDocument(req, requestId, {
        sourceDocumentId: Number(sourceDocumentId),
        sourceDocumentVersion:
          sourceDocumentVersion !== undefined &&
          sourceDocumentVersion !== null &&
          sourceDocumentVersion !== ""
            ? Number(sourceDocumentVersion)
            : null,
      });

    return res.json({
      success: true,
      message: "Existing DMS document selected successfully",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 6
// Owner prepares temporary share
//
// POST /api/cross-department-requests/:id/prepare
//
// Body:
//
// {
//   durationMinutes: 60,
//   maskingRequired: false
// }
//
// OR:
//
// {
//   durationMinutes: 1440,
//   maskingRequired: true
// }
//
// IMPORTANT:
//
// Client MUST NOT submit arbitrary expiresAt.
//
// Server calculates expiresAt from durationMinutes.
//
// ─────────────────────────────────────────────────────────────

const prepareShare = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);

    const requestId = Number(req.params.id);

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid request id",
      });
    }

    const {
      durationMinutes,
      maskingRequired = false,
    } = req.body || {};

    if (
      durationMinutes === undefined ||
      durationMinutes === null ||
      durationMinutes === ""
    ) {
      return res.status(400).json({
        success: false,
        message: "durationMinutes is required",
      });
    }

    const parsedDuration = Number(durationMinutes);

    if (
      !Number.isFinite(parsedDuration) ||
      parsedDuration <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "durationMinutes must be a positive number",
      });
    }

    if (parsedDuration > 10080) {
      return res.status(400).json({
        success: false,
        message:
          "Maximum temporary access duration is 7 days",
      });
    }

    const result =
      await crossDepartmentDocumentService.prepareShare(req, requestId, {
        durationMinutes: parsedDuration,
        maskingRequired: Boolean(maskingRequired),
      });

    return res.status(201).json({
      success: true,
      message: "Temporary document share prepared",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 7
// Mask temporary share
//
// POST /api/cross-department-shares/:id/mask
//
// IMPORTANT:
//
// Masking data belongs ONLY to temporary share.
//
// It MUST NEVER be written to the original DMS Document.
//
// Example body:
//
// {
//   "masks": [
//     {
//       "page": 1,
//       "x": 100,
//       "y": 120,
//       "width": 200,
//       "height": 50
//     }
//   ]
// }
//
// Actual coordinate validation / PDF/image flattening happens inside
// crossDepartmentDocumentService.
// ─────────────────────────────────────────────────────────────

const maskShare = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);

    const shareId = Number(req.params.id);

    if (!Number.isInteger(shareId) || shareId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid share id",
      });
    }

    const masks =
      req.body?.masks ||
      req.body?.maskData ||
      req.body?.annotations ||
      [];

    if (!Array.isArray(masks) || masks.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Mask data is required",
      });
    }

    const result =
      await crossDepartmentDocumentService.maskShare(req, shareId, {
        masks,
      });

    return res.json({
      success: true,
      message: "Temporary document masked successfully",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 8
// Send temporary share
//
// POST /api/cross-department-shares/:id/send
//
// Owner confirms:
//
// Send Without Masking
// OR
// Mask & Send
//
// Recipient gets access ONLY through shareId.
// ─────────────────────────────────────────────────────────────

const sendShare = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);

    const shareId = Number(req.params.id);

    if (!Number.isInteger(shareId) || shareId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid share id",
      });
    }

    const result =
      await crossDepartmentDocumentService.sendShare(req, shareId);

    return res.json({
      success: true,
      message: "Temporary document shared successfully",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 9
// Recipient views temporary document
//
// GET /api/cross-department-shares/:id/view
//
// SECURITY:
//
// Service MUST verify:
//
// tenantId === share.tenantId
// currentUser.id === share.recipientUserId
// status === ACTIVE
// current server time < expiresAt
//
// Never call the normal document view endpoint.
// ─────────────────────────────────────────────────────────────

const viewShare = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);

    const shareId = Number(req.params.id);

    if (!Number.isInteger(shareId) || shareId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid share id",
      });
    }

    const file =
      await crossDepartmentDocumentService.viewShare(req, shareId);

    if (!file || !file.buffer) {
      return res.status(404).json({
        success: false,
        message: "Temporary shared document not found",
      });
    }

    if (file.mimeType) {
      res.setHeader("Content-Type", file.mimeType);
    }

    if (file.fileName) {
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${String(file.fileName).replace(/"/g, "")}"`
      );
    }

    return res.send(file.buffer);
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 10
// Recipient downloads temporary document
//
// GET /api/cross-department-shares/:id/download
// ─────────────────────────────────────────────────────────────

const downloadShare = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);

    const shareId = Number(req.params.id);

    if (!Number.isInteger(shareId) || shareId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid share id",
      });
    }

    const file =
      await crossDepartmentDocumentService.downloadShare(req, shareId);

    if (!file || !file.buffer) {
      return res.status(404).json({
        success: false,
        message: "Temporary shared document not found",
      });
    }

    res.setHeader(
      "Content-Type",
      file.mimeType || "application/octet-stream"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${String(
        file.fileName || "shared-document"
      ).replace(/"/g, "")}"`
    );

    return res.send(file.buffer);
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 11
// Revoke temporary share
//
// POST /api/cross-department-shares/:id/revoke
//
// Only authorized grantor/admin can revoke.
// ─────────────────────────────────────────────────────────────

const revokeShare = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);

    const shareId = Number(req.params.id);

    if (!Number.isInteger(shareId) || shareId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid share id",
      });
    }

    const reason =
      req.body?.reason
        ? String(req.body.reason).trim()
        : null;

    const result =
      await crossDepartmentDocumentService.revokeShare(req, shareId, reason);

    return res.json({
      success: true,
      message: "Temporary document share revoked successfully",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// STEP 12
// Reject request
//
// POST /api/cross-department-requests/:id/reject
// ─────────────────────────────────────────────────────────────

const rejectRequest = async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);

    const requestId = Number(req.params.id);

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid request id",
      });
    }

    const reason =
      req.body?.reason
        ? String(req.body.reason).trim()
        : null;

    const result =
      await crossDepartmentDocumentService.rejectRequest(req, {
        requestId,
        reason,
      });

    return res.json({
      success: true,
      message: "Document access request rejected",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};


// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
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
};