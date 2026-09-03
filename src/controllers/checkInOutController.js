// src/controllers/checkInOutController.js
//
// Enterprise Check-In / Check-Out endpoints. All business rules live in
// checkInOutService.js — this controller only does request parsing,
// (for check-in) the same temp-file + new-version-row + OCR-trigger
// pattern already used by documentController.uploadDocument, and
// response shaping.
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { Op } = require("sequelize");
// PHASE G — Document/DocumentType/User are tenant-side models.
const CheckInOutService = require("../services/checkInOutService");
const processOCR = require("../workers/ocrWorker");

const sendServiceError = (res, error, fallbackMessage) => {
  const status = error.statusCode || 500;
  return res.status(status).json({
    success: false,
    message: error.message || fallbackMessage,
  });
};

// ── POST /documents/:id/checkout ─────────────────────────────
const checkOut = async (req, res) => {
  try {
    const { Document, DocumentType, User } = req.models;
    const { reason, expectedReturnDate } = req.body || {};

    const root = await CheckInOutService.checkOut({
      documentId: req.params.id,
      user: req.user,
      reason,
      expectedReturnDate: expectedReturnDate || null,
      req,
    });

    const latestVersion = await CheckInOutService.getLatestVersionNumber(req.models, root.id, req.user.tenantId);

    return res.status(200).json({
      success: true,
      message: "Document checked out successfully",
      data: CheckInOutService.lockStatusPayload(root, latestVersion),
    });
  } catch (error) {
    console.error("Check-out error:", error.message);
    return sendServiceError(res, error, "Check-out failed");
  }
};

// ── POST /documents/:id/checkin ──────────────────────────────
// multipart/form-data: optional `file` field (modified document) +
// optional `comments` field. If a file is supplied, a new version row
// is created via the exact same flow as documentController.uploadDocument
// (temp file -> Document.create -> processOCR), so OCR + the existing
// Approval Workflow (triggered later via generate-tcode, unmodified)
// still apply to the new version exactly as they do for a fresh upload.
const checkIn = async (req, res) => {
  let newVersionDoc = null;

  try {
    const { Document, DocumentType, User } = req.models;
    const { comments } = req.body || {};
    const file = req.file;
    const tenantId = req.user.tenantId;

    const root = await CheckInOutService.resolveRoot(req.models, req.params.id, tenantId);
    if (!root) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }
    if (!root.isCheckedOut) {
      return res.status(400).json({
        success: false,
        message: "Document is not currently checked out.",
      });
    }
    if (root.checkedOutBy !== req.user.id) {
      return res.status(403).json({
        success: false,
        message:
          "Only the user who checked out this document can check it in. Ask a Tenant/Department Admin to force-unlock it.",
      });
    }

    if (file) {
      const docType = await DocumentType.findOne({
        where: { id: root.documentTypeId, tenantId },
      });

      const allowedTypes = docType?.allowedMimeTypes || [];
      if (allowedTypes.length > 0 && !allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: `File type ${file.mimetype} is not allowed. Allowed: ${allowedTypes.join(", ")}`,
        });
      }

      const fileName = uuidv4() + path.extname(file.originalname);
      const tempDir = path.join(process.cwd(), "uploads", "temp");
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempPath = path.join(tempDir, fileName);
      fs.writeFileSync(tempPath, file.buffer);

      const latestChild = await Document.findOne({
        where: { parentDocumentId: root.id, status: "ACTIVE" },
        order: [["version", "DESC"]],
      });
      const nextVersion = latestChild ? latestChild.version + 1 : root.version + 1;

      newVersionDoc = await Document.create({
        tenantId: root.tenantId,
        departmentId: root.departmentId,
        categoryId: root.categoryId,
        documentTypeId: root.documentTypeId,
        uploadedBy: req.user.id,
        originalFileName: file.originalname,
        mimeType: file.mimetype,
        fileSizeBytes: file.size,
        uploadStatus: "OCR_PROCESSING",
        tempFilePath: tempPath,
        version: nextVersion,
        parentDocumentId: root.id,
        activityLogs: [
          {
            message: "Uploading modified version via Check-In...",
            status: "SUCCESS",
            timestamp: new Date(),
          },
          {
            message: "Starting OCR process...",
            status: "PROCESSING",
            timestamp: new Date(),
          },
        ],
      });

      processOCR(newVersionDoc.id, req.models);
    }

    const updatedRoot = await CheckInOutService.checkIn({
      documentId: root.id,
      user: req.user,
      comments,
      newVersionDoc,
      req,
    });

    const latestVersion = await CheckInOutService.getLatestVersionNumber(
      req.models,
      updatedRoot.id,
      req.user.tenantId
    );

    return res.status(200).json({
      success: true,
      message: file
        ? "Document checked in — new version created and sent for OCR"
        : "Document checked in (lock released, no new version uploaded)",
      data: {
        ...CheckInOutService.lockStatusPayload(updatedRoot, latestVersion),
        newVersionId: newVersionDoc?.id || null,
        newVersionNumber: newVersionDoc?.version || null,
      },
    });
  } catch (error) {
    console.error("Check-in error:", error.message);
    return sendServiceError(res, error, "Check-in failed");
  }
};

// ── POST /documents/:id/force-unlock ─────────────────────────
const forceUnlock = async (req, res) => {
  try {
    const { Document, DocumentType, User } = req.models;
    const { reason } = req.body || {};

    const root = await CheckInOutService.forceUnlock({
      documentId: req.params.id,
      user: req.user,
      reason,
      req,
    });

    const latestVersion = await CheckInOutService.getLatestVersionNumber(req.models, root.id, req.user.tenantId);

    return res.status(200).json({
      success: true,
      message: "Document force-unlocked successfully",
      data: CheckInOutService.lockStatusPayload(root, latestVersion),
    });
  } catch (error) {
    console.error("Force-unlock error:", error.message);
    return sendServiceError(res, error, "Force-unlock failed");
  }
};

// ── GET /documents/:id/lock-status ───────────────────────────
const getLockStatus = async (req, res) => {
  try {
    const { Document, DocumentType, User } = req.models;
    const root = await CheckInOutService.resolveRoot(req.models, req.params.id, req.user.tenantId);
    if (!root) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }
    const latestVersion = await CheckInOutService.getLatestVersionNumber(req.models, root.id, req.user.tenantId);
    return res.json({ success: true, data: CheckInOutService.lockStatusPayload(root, latestVersion) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── GET /documents/:id/version-history ───────────────────────
// Same version-family resolution already used by
// documentController.getDocumentVersions, plus current lock status.
const getVersionHistory = async (req, res) => {
  try {
    const { Document, DocumentType, User } = req.models;
    const tenantId = req.user.tenantId;

    const doc = await Document.findOne({
      where: { id: req.params.id, tenantId, status: "ACTIVE" },
    });

    if (!doc) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    const rootId = doc.parentDocumentId || doc.id;

    const versions = await Document.findAll({
      where: {
        [Op.or]: [{ id: rootId }, { parentDocumentId: rootId }],
        status: "ACTIVE",
      },
      include: [{ model: User, as: "uploader", attributes: ["id", "email"] }],
      order: [["version", "DESC"]],
    });

    const root = await Document.findByPk(rootId);
    const latestVersion = versions.length > 0 ? versions[0].version : null;

    return res.json({
      success: true,
      lockStatus: CheckInOutService.lockStatusPayload(root, latestVersion),
      data: versions,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  checkOut,
  checkIn,
  forceUnlock,
  getLockStatus,
  getVersionHistory,
};
