// src/controllers/documentController.js
// PHASE G — Document/DocumentType/Category/User/DocumentApproval are
// tenant-side models (req.models). Tenant/ErpConfig/Department are
// Master DB models (req.masterModels). Several queries below used to
// `include: [{ model: Department }]` on a tenant-side model — that's a
// cross-database join Sequelize can't do once they're on separate
// physical connections, so those are split into two queries and merged
// in JS (see hydrateDepartments() below).
const ErpFactory = require("../services/erpFactory");
const SapService = require("../services/sapService");
const processOCR = require("../workers/ocrWorker"); 
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const ApprovalEngineService = require("../services/approvalEngineService");
const SapFinalizationService = require("../services/sapFinalizationService");
const CheckInOutService = require("../services/checkInOutService");
const userAssignmentService = require("../services/userAssignmentService");
const documentSearchService = require("../services/documentSearchService");
const { Op } = require("sequelize");
// ── Subscription Management System ──────────────────────────
const { finalizeDocumentLocally } = require("../services/localFinalizationService");
const WatermarkService = require("../services/watermarkService");
const ThumbnailService = require("../services/thumbnailService");
const fsPromises = require("fs/promises");
// ── SAP Content API integration ─────────────────────────────
// Generic, non-SAP-specific binary store (the SAME service
// sapContentRetrievalService.js and vaultUploadService.js already use).
// Documents with sourceType = "SAP_CONTENT_API" have their binary here,
// in the tenant's own database, NOT on SAP's Content Server — so
// view/download/thumbnail must read it from here instead of calling
// ErpFactory/SapService for those documents specifically. This does NOT
// change behavior for LOCAL_UPLOAD or SAP_SYNC documents at all.
const documentContentService = require("../services/documentContentService");

// ── Subscription Management System: robust FREE-tenant check ───────────
// Always compares uppercased so "FREE" / "Free" / "free" all match, and
// never throws if req.tenant somehow wasn't populated by the middleware
// chain (treated as not-FREE in that case, same as before).
const isFreeTenant = (req) =>
  !!req.tenant && String(req.tenant.tenantType).toUpperCase() === "FREE";

const getErpConfigForTenant = async (tenantId, masterModels) => {
  const { Tenant, ErpConfig } = masterModels;
  const tenant = await Tenant.findByPk(tenantId, {
    include: [
      {
        model: ErpConfig,
      },
    ],
  });

  if (!tenant || !tenant.ErpConfig) {
    throw new Error("ERP configuration not assigned to tenant");
  }

  return tenant.ErpConfig;
};

// Hydrates the (Master DB) Department name onto one or more plain
// Document-family objects that carry a departmentId, since Sequelize
// can't `include` across the tenant/master database boundary. Accepts
// either a single object or an array; mutates and returns the same shape.
async function hydrateDepartments(masterModels, docOrDocs) {
  const list = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
  const ids = [...new Set(list.map((d) => d?.departmentId).filter(Boolean))];
  if (!ids.length) return docOrDocs;
  const { Op } = require("sequelize");
  const departments = await masterModels.Department.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: ["id", "name", "code"],
    raw: true,
  });
  const byId = new Map(departments.map((d) => [d.id, d]));
  for (const d of list) {
    if (d) d.Department = d.departmentId ? byId.get(d.departmentId) || null : null;
  }
  return docOrDocs;
}

// ── Upload a document ───────────────────────────────────────
const uploadDocument = async (req, res) => {
  let documentRecord = null;

  try {
    const { Document, DocumentType, Category } = req.models;
    const tenantId = req.user.tenantId;
    const uploadedBy = req.user.id;
    const file = req.file; // multer in-memory buffer

    const documentTypeId = req.body?.documentTypeId;
    const metadata = req.body?.metadata;

    // 1. Validate file
    if (!file) {
      return res.status(400).json({
        success: false,
        message:
          "No file uploaded. Make sure field name is 'file' and Content-Type is NOT set manually.",
      });
    }

    // 1b. FREE tenants keep document binaries on local disk. Enforce the
    // tenant file quota before writing the temporary upload so a tenant
    // cannot consume disk beyond the SuperAdmin-configured limit.
    if (isFreeTenant(req)) {
      const { assertFileQuota } = require("../services/tenantStorageService");
      try {
        await assertFileQuota(tenantId, file.size);
      } catch (quotaError) {
        if (quotaError.code === "FILE_STORAGE_QUOTA_EXCEEDED") {
          return res.status(quotaError.statusCode || 413).json({
            success: false,
            code: quotaError.code,
            message: quotaError.message,
            currentBytes: quotaError.currentBytes,
            quotaBytes: quotaError.quotaBytes,
            incomingBytes: quotaError.incomingBytes,
          });
        }
        throw quotaError;
      }
    }

    // 2. Validate documentTypeId
    if (!documentTypeId) {
      return res.status(400).json({
        success: false,
        message: "documentTypeId is required",
      });
    }

    // 3. Fetch the document type
    const docType = await DocumentType.findOne({
      where: { id: documentTypeId, tenantId, status: "ACTIVE" },
      include: [{ model: Category }],
    });

    if (!docType) {
      return res.status(404).json({
        success: false,
        message: "Document type not found or not accessible",
      });
    }

    // Department is Master DB — resolved separately for the audit log
    // below (see hydrateDepartments() header comment).
    const uploadDepartment = docType.Category?.departmentId
      ? await req.masterModels.Department.findByPk(docType.Category.departmentId, { attributes: ["id", "name"] })
      : null;

    // 3b. Dynamic User Assignment Engine: user must have DEPARTMENT,
    // CATEGORY, or DOCUMENT_TYPE level access to this document type.
    const hasUploadAccess = await userAssignmentService.hasDocumentTypeAccess(
      req.models,
      tenantId,
      uploadedBy,
      req.user.role,
      docType.id
    );
    if (!hasUploadAccess) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to upload into this document type",
      });
    }

    // 4. Validate mime type
    const allowedTypes = docType.allowedMimeTypes || [];
    if (allowedTypes.length > 0 && !allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: `File type ${file.mimetype} is not allowed. Allowed: ${allowedTypes.join(", ")}`,
      });
    }

    // 5. Write temp file — OUTSIDE metadata block so tempPath is always defined
    const fileName = uuidv4() + path.extname(file.originalname);
    const tempDir = path.join(process.cwd(), "uploads", "temp");

    // Create temp dir if it doesn't exist
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempPath = path.join(tempDir, fileName);
    fs.writeFileSync(tempPath, file.buffer);

    // 6. Parse metadata safely
    let parsedMetadata = null;
    if (metadata) {
      try {
        parsedMetadata =
          typeof metadata === "string" ? JSON.parse(metadata) : metadata;
      } catch (e) {
        return res.status(400).json({
          success: false,
          message:
            'metadata must be a valid JSON string. Example: {"key":"value"}',
        });
      }
    }
    // ── Version check ──────────────────────────────────────────
    let parentDocumentId = null;
    let version = 1;

    const existingRoot = await Document.findOne({
      where: {
        tenantId,
        documentTypeId,
        originalFileName: file.originalname,
        status: "ACTIVE",
        parentDocumentId: null,
      },
    });

    if (existingRoot) {
      // ── Check-In/Check-Out lock guard ─────────────────────
      // If another user currently holds the check-out lock on this
      // document family, they must check-in (or be force-unlocked) before
      // anyone else can push a new version through the regular upload
      // endpoint. No-op when the document isn't checked out.
      try {
        CheckInOutService.assertNotLockedByOther(existingRoot, uploadedBy);
      } catch (lockError) {
        return res.status(lockError.statusCode || 423).json({
          success: false,
          message: lockError.message,
        });
      }

      parentDocumentId = existingRoot.id;
      // Latest version number nikalo
      const { Op } = require("sequelize");
      const latestChild = await Document.findOne({
        where: {
          parentDocumentId: existingRoot.id,
          status: "ACTIVE",
        },
        order: [["version", "DESC"]],
      });
      version = latestChild
        ? latestChild.version + 1
        : existingRoot.version + 1;
    }
    // ── Version check END ──────────────────────────────────────

    // 7. Create DB record
    documentRecord = await Document.create({
      tenantId,
      departmentId: docType.Category.departmentId,
      categoryId: docType.categoryId,
      documentTypeId,
      uploadedBy,
      originalFileName: file.originalname,
      mimeType: file.mimetype,
      fileSizeBytes: file.size,
      uploadStatus: "OCR_PROCESSING",
      tempFilePath: tempPath,
      version, // ✅ ADD
      parentDocumentId, // ✅ ADD

      metadata: parsedMetadata,
      activityLogs: [
        {
          message: "Uploading document...",
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

    processOCR(documentRecord.id, req.models);

    // ── Audit: document uploaded ──────────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD,
      department: uploadDepartment?.name,
      documentId: documentRecord.id,
      newValue: {
        originalFileName: file.originalname,
        documentTypeId,
        version,
        parentDocumentId,
      },
      remarks: `Uploaded "${file.originalname}" (v${version})`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({
      success: true,
      message: "OCR started",
      documentId: documentRecord.id,
    });
  } catch (error) {
    if (documentRecord && documentRecord.uploadStatus === "PENDING") {
      await documentRecord.update({ uploadStatus: "FAILED" }).catch(() => {});
    }
    console.error("Document upload error:", error.message);

    // ── Audit: document upload failed ─────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD_FAILED,
      documentId: documentRecord?.id,
      status: AUDIT_STATUS.FAILED,
      remarks: "Document upload failed: " + error.message,
    });

    return res.status(500).json({
      success: false,
      message: "Document upload failed: " + error.message,
    });
  }
};

// ── List documents ───────────────────────────────────────────
const listDocuments = async (req, res) => {
  try {
    const { Document, Category, DocumentType, User } = req.models;
    const tenantId = req.user.tenantId;
    const { departmentId, categoryId, documentTypeId, uploadStatus } =
      req.query;

    const baseWhere = { tenantId, status: "ACTIVE" };
    if (departmentId) baseWhere.departmentId = departmentId;
    if (categoryId) baseWhere.categoryId = categoryId;
    if (documentTypeId) baseWhere.documentTypeId = documentTypeId;

    // ── Dynamic User Assignment Engine: auto-filter to allowed documents.
    // Document rows always carry documentTypeId, and resolveScope() already
    // cascades DEPARTMENT/CATEGORY assignments down to the full set of
    // documentTypeIds they cover, so filtering on documentTypeId alone is
    // sufficient and correct at every level.
    const scope = await userAssignmentService.resolveScope(
      req.models,
      tenantId,
      req.user.id,
      req.user.role
    );
    if (scope) {
      if (documentTypeId && !scope.documentTypeIds.includes(Number(documentTypeId))) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this document type",
        });
      }
      if (!scope.documentTypeIds.length) {
        return res.json({ success: true, data: [], total: 0 });
      }
      baseWhere.documentTypeId = documentTypeId
        ? documentTypeId
        : { [Op.in]: scope.documentTypeIds };
    }

    // Pehle SAARE active documents (root + versions) le lo
    const allDocs = await Document.findAll({
      where: baseWhere,
      include: [
        { model: Category, attributes: ["id", "name"] },
        { model: DocumentType, attributes: ["id", "name"] },
        { model: User, as: "uploader", attributes: ["id", "email"] },
      ],
      order: [["version", "DESC"]],
    });

    // Har family (root id ya khud ka id) ka SIRF latest version rakho
    const latestByFamily = new Map();
    for (const doc of allDocs) {
      const familyId = doc.parentDocumentId || doc.id;
      const existing = latestByFamily.get(familyId);
      if (!existing || doc.version > existing.version) {
        latestByFamily.set(familyId, doc);
      }
    }

    let docs = Array.from(latestByFamily.values()).map((d) => d.toJSON());

    // Status filter ab latest version ke status pe lagao
    if (uploadStatus) {
      docs = docs.filter((d) => d.uploadStatus === uploadStatus);
    }

    docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    await hydrateDepartments(req.masterModels, docs);

    return res.json({ success: true, data: docs, total: docs.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Get single document ──────────────────────────────────────
const getDocument = async (req, res) => {
  try {
    const { Document, Category, DocumentType, User } = req.models;
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    const doc = await Document.findOne({
      where: { id, tenantId, status: "ACTIVE" },
      include: [
        { model: Category },
        { model: DocumentType },
        { model: User, as: "uploader", attributes: ["id", "email"] },
      ],
    });

    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Document not found" });
    }

    const allowed = await userAssignmentService.hasDocumentTypeAccess(
      req.models,
      tenantId,
      req.user.id,
      req.user.role,
      doc.documentTypeId
    );
    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this document",
      });
    }

    const docJson = doc.toJSON();
    await hydrateDepartments(req.masterModels, docJson);

    return res.json({ success: true, data: docJson });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Soft delete ──────────────────────────────────────────────
const deleteDocument = async (req, res) => {
  try {
    const { Document } = req.models;
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    const doc = await Document.findOne({ where: { id, tenantId } });
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Document not found" });
    }

    // ── Check-In/Check-Out lock guard ───────────────────────
    // A checked-out document cannot be deleted by anyone but the lock
    // owner; a Tenant/Department Admin must force-unlock it first. No-op
    // when the document isn't checked out.
    try {
      const root = await CheckInOutService.resolveRoot(req.models, doc.id, tenantId);
      CheckInOutService.assertNotLockedByOther(root, req.user.id);
    } catch (lockError) {
      return res.status(lockError.statusCode || 423).json({
        success: false,
        message: lockError.message,
      });
    }

    const previousStatus = doc.status;
    await doc.update({ status: "DELETED" });

    // ── Audit: document deleted ───────────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT,
      action: AUDIT_ACTIONS.DOCUMENT_DELETE,
      documentId: doc.id,
      sapDocumentId: doc.sapDocumentId,
      oldValue: { status: previousStatus },
      newValue: { status: "DELETED" },
      remarks: `Document "${doc.originalFileName}" deleted`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, message: "Document deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Get from SAP ─────────────────────────────────────────────
const getDocumentFromSap = async (req, res) => {
  try {
    const { Document } = req.models;
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    const doc = await Document.findOne({
      where: { id, tenantId, status: "ACTIVE" },
    });

    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Document not found" });
    }

    if (!doc.sapDocumentId) {
      return res.status(400).json({
        success: false,
        message: "This document has no SAP reference (upload may have failed)",
      });
    }

    const erpConfig = await getErpConfigForTenant(tenantId, req.masterModels);

    const erpService = ErpFactory.getService(erpConfig);

    const sapData = await erpService.getDocumentById(
      erpConfig,
      doc.sapDocumentId,
    );

    // ── Audit: SAP retrieval ───────────────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP,
      action: AUDIT_ACTIONS.SAP_RETRIEVAL,
      documentId: doc.id,
      sapDocumentId: doc.sapDocumentId,
      remarks: `Fetched SAP metadata for document ${doc.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: sapData });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Reprocess OCR ────────────────────────────────────────────
// Re-runs OCR + dynamic metadata mapping for an EXISTING document,
// without requiring a fresh upload. Needed because publishing a new
// MetadataTemplateVersion (e.g. after adding an OCR alias) never
// rewrites already-processed documents — dynamicOcrMappingService only
// ever runs once, at original upload time (see ocrWorker.js). This lets
// a Tenant Admin re-trigger that same pipeline on demand, e.g. right
// after fixing an alias, to verify the fix without re-uploading the file.
const reprocessOcr = async (req, res) => {
  const { Document } = req.models;
  const document = await Document.findOne({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });

  if (!document) {
    return res.status(404).json({ success: false, message: "Document not found" });
  }

  if (!document.tempFilePath || !fs.existsSync(document.tempFilePath)) {
    // Once a document is finalized (SAP/local), tempFilePath is deleted —
    // there is nothing left on disk to re-OCR at that point.
    return res.status(400).json({
      success: false,
      message: "Original file is no longer available for this document (it may already be finalized), so it can't be reprocessed.",
    });
  }

  const logs = Array.isArray(document.activityLogs) ? [...document.activityLogs] : [];
  logs.push({
    message: "OCR reprocessing triggered manually...",
    status: "PROCESSING",
    timestamp: new Date(),
  });
  await document.update({ uploadStatus: "OCR_PROCESSING", activityLogs: logs });

  // Fire-and-forget, same pattern as the original upload flow — the
  // frontend polls GET /:id/status (or GET /:id/metadata) exactly like
  // it already does right after upload.
  processOCR(document.id, req.models);

  await AuditService.log({
    req,
    module: AUDIT_MODULES.OCR,
    action: AUDIT_ACTIONS.OCR_REPROCESS_TRIGGERED,
    documentId: document.id,
    remarks: `OCR manually reprocessed for document ${document.id}`,
    status: AUDIT_STATUS.SUCCESS,
  });

  return res.json({ success: true, message: "OCR reprocessing started", status: "OCR_PROCESSING" });
};

// ── Status ───────────────────────────────────────────────────
const getDocumentStatus = async (req, res) => {
  const { Document } = req.models;
  const document = await Document.findByPk(req.params.id);

  if (!document) {
    return res.status(404).json({ success: false });
  }

  return res.json({
    success: true,
    status: document.uploadStatus,
    // Diagnostic only — { extractedText } straight from Tesseract, kept
    // solely because the AI Document Assistant (documentIndexingService /
    // vectorSearchService) reads document.ocrMetadata.extractedText to
    // index this document for chat search. The old static Invoice-shaped
    // field list (invoiceNumber, poNumber, vendorName, ...) has been
    // retired — for actual extracted fields, callers must use
    // GET /api/documents/:id/metadata (documentMetadataController), which
    // is backed by the Dynamic Metadata Template Engine.
    legacyOcrMetadata: document.ocrMetadata,
    tcode: document.tcode,
  });
};


// ── Generate TCode ───────────────────────────────────────────
const generateTcode = async (req, res) => {
  const { Document } = req.models;
  const document = await Document.findByPk(req.params.id);
  const logs = document.activityLogs || [];

  logs.push({
    message: "Generating TCode...",
    status: "PROCESSING",
    timestamp: new Date(),
  });

  const tcode = "DMS-" + Date.now();

  logs.push({
    message: `TCode generated: ${tcode}`,
    status: "SUCCESS",
    timestamp: new Date(),
  });

  await document.update({
    tcode,
    uploadStatus: "WAITING_FOR_APPROVAL",
    activityLogs: logs,
  });

  // ── Audit: TCode generated ────────────────────────────────
  await AuditService.log({
    req,
    module: AUDIT_MODULES.DOCUMENT,
    action: AUDIT_ACTIONS.TCODE_GENERATED,
    documentId: document.id,
    newValue: { tcode },
    remarks: `Generated TCode ${tcode} for document ${document.id}`,
    status: AUDIT_STATUS.SUCCESS,
  });

  // ── Approval Engine hook ───────────────────────────────────
  // Only runs the workflow if the Tenant Admin has actually configured
  // one for this document's Department/Category/DocumentType combo.
  // If not, nothing changes here — uploadStatus stays WAITING_FOR_APPROVAL
  // exactly as before, and the frontend calls /finalize directly.
  let approval = { required: false, documentApproval: null };
  try {
    approval = await ApprovalEngineService.initiate({ document, user: req.user, req });
  } catch (engineError) {
    console.error("Approval Engine initiate error:", engineError.message);
  }

  res.json({
    success: true,
    tcode,
    approvalRequired: approval.required,
    documentApprovalId: approval.documentApproval?.id || null,
  });
};

// ── Finalize (save to SAP) ───────────────────────────────────
const finalizeDocument = async (req, res) => {
  const { Document, DocumentType, Category, DocumentApproval } = req.models;
  // Department is Master DB — not include-able across the connection
  // boundary. sapFinalizationService/localFinalizationService (not yet
  // converted this phase — see PHASE_G_LEGACY_REMOVAL_REPORT.md) have
  // their own fallback re-fetch when document.DocumentType is present but
  // .Category.Department isn't, so omitting it here doesn't remove
  // functionality — it just means that fallback path is exercised.
  const document = await Document.findByPk(req.params.id, {
    include: [
      {
        model: DocumentType,
        include: [{ model: Category }],
      },
    ],
  });

  // ── Approval Engine guard ─────────────────────────────────
  // If this document has an approval workflow in progress (or blocked),
  // it must NOT be pushed to SAP directly — SAP Upload must happen ONLY
  // after final approval. Documents with no approval workflow configured
  // have no DocumentApproval row at all, so this is a complete no-op for
  // them and they finalize exactly as before.
  const documentApproval = await DocumentApproval.findOne({ where: { documentId: document.id } });
  if (documentApproval && documentApproval.status !== "COMPLETED") {
    return res.status(409).json({
      success: false,
      message: `This document requires approval before it can be sent to SAP (current approval status: ${documentApproval.status}). Use the approval workflow endpoints instead of /finalize.`,
      approvalStatus: documentApproval.status,
      documentApprovalId: documentApproval.id,
    });
  }
  if (documentApproval && documentApproval.status === "COMPLETED") {
    // Already finalized to SAP by the Approval Engine on final approval.
    return res.json({ success: true, message: "Document already finalized via approval workflow" });
  }

  // ── Subscription Management System: FREE tenants never reach SAP ──
  // code. Approval-engine gating above still applies identically to both;
  // only the "where does the binary end up" step differs.
  if (isFreeTenant(req)) {
    try {
      const result = await finalizeDocumentLocally(document, req);
      return res.json({ success: true, localFilePath: result.localFilePath });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  const sapData = await SapFinalizationService.finalizeDocumentToSap(document, req);

  res.json({ success: true, sapDocumentId: sapData.sapDocumentId, sapPhioId: sapData.sapPhioId });
};

// ── Activity log ─────────────────────────────────────────────
const getDocumentActivity = async (req, res) => {
  const { Document } = req.models;
  const document = await Document.findByPk(req.params.id);

  if (!document) {
    return res
      .status(404)
      .json({ success: false, message: "Document not found" });
  }

  return res.json({
    success: true,
    logs: document.activityLogs || [],
  });
};

const searchByTcode = async (req, res) => {
  try {
    const { tcode } = req.query;

    if (!tcode) {
      return res.status(400).json({
        success: false,
        message: "tcode is required",
      });
    }

    const { Document, Category, DocumentType, User } = req.models;
    const document = await Document.findOne({
      where: {
        tenantId: req.user.tenantId,
        tcode,
        status: "ACTIVE",
      },
      include: [
        { model: Category },
        { model: DocumentType },
        {
          model: User,
          as: "uploader",
          attributes: ["id", "email"],
        },
      ],
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Document not found",
      });
    }

    const docJson = document.toJSON();
    await hydrateDepartments(req.masterModels, docJson);

    return res.json({
      success: true,
      data: docJson,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── View ─────────────────────────────────────────────────────
// Subscription Management System: FREE tenants ALWAYS view from local
// storage (watermarked) — regardless of whether the document happens to
// have a sapDocumentId or not. Only PAID/non-FREE tenants ever hit SAP.
const viewDocument = async (req, res) => {
  try {
    const { Document } = req.models;
    if (isFreeTenant(req)) {
      const document = await Document.findOne({
        where: { id: req.params.id, tenantId: req.user.tenantId, status: "ACTIVE" },
      });
      if (!document || !document.localFilePath || !fs.existsSync(document.localFilePath)) {
        return res.status(404).json({ success: false, message: "Document not found" });
      }

      const buffer = await fsPromises.readFile(document.localFilePath);
      const watermarked = await WatermarkService.watermark(buffer, document.mimeType);

      await AuditService.log({
        req,
        module: AUDIT_MODULES.DOCUMENT,
        action: AUDIT_ACTIONS.DOCUMENT_VIEW,
        documentId: document.id,
        remarks: `Viewed local (watermarked) document ${document.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      res.setHeader("Content-Type", document.mimeType);
      return res.send(watermarked);
    }

    // ── PAID tenants: :id here is our own Document row id, so resolve it
    // to the actual sapDocumentId before calling SAP.
    const document = await Document.findOne({
      where: { id: req.params.id, tenantId: req.user.tenantId, status: "ACTIVE" },
    });
    if (!document) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    // ── DB-backed SAP Content API storage ─────────────────────
    // These documents' binary was pushed by SAP directly into our
    // DocumentContent table (see vaultUploadService.js) — it never lived
    // on SAP's Content Server, so calling out to SAP for it (below)
    // would always 404 there. Route BEFORE the "!sapDocumentId" check:
    // SAP_CONTENT_API documents always HAVE a sapDocumentId (it's SAP's
    // own identifier, required at upload time) but that identifier is
    // never used to call SAP for retrieval.
    if (document.sourceType === "SAP_CONTENT_API") {
      const contentRow = await documentContentService.getDocumentContent({
        models: req.models,
        documentId: document.id,
      });
      if (!contentRow) {
        return res.status(404).json({ success: false, message: "Document not found" });
      }

      await AuditService.log({
        req,
        module: AUDIT_MODULES.DOCUMENT,
        action: AUDIT_ACTIONS.DOCUMENT_VIEW,
        documentId: document.id,
        sapDocumentId: document.sapDocumentId,
        remarks: `Viewed DB-backed SAP Content API document ${document.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      res.setHeader("Content-Type", document.mimeType || "application/octet-stream");
      return res.send(contentRow.content);
    }

    if (!document.sapDocumentId) {
      // Not in SAP yet — most commonly because it's sitting in an
      // in-progress Approval workflow (SAP Upload only happens after
      // final approval). Serve the local temp copy saved at upload time
      // instead of failing, so an approver can still review the file.
      if (document.tempFilePath && fs.existsSync(document.tempFilePath)) {
        const buffer = await fsPromises.readFile(document.tempFilePath);

        await AuditService.log({
          req,
          module: AUDIT_MODULES.DOCUMENT,
          action: AUDIT_ACTIONS.DOCUMENT_VIEW,
          documentId: document.id,
          remarks: `Viewed pre-approval local copy of document ${document.id}`,
          status: AUDIT_STATUS.SUCCESS,
        });

        res.setHeader("Content-Type", document.mimeType);
        return res.send(buffer);
      }

      return res.status(400).json({
        success: false,
        message: "This document has no SAP reference (upload may have failed)",
      });
    }

    const sapDocumentId = document.sapDocumentId;
    const erpConfig = await getErpConfigForTenant(req.user.tenantId, req.masterModels);
    const erpService = ErpFactory.getService(erpConfig);

    const file = await erpService.getDocumentBinary(erpConfig, sapDocumentId);

    // ── Audit: document viewed ────────────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT,
      action: AUDIT_ACTIONS.DOCUMENT_VIEW,
      documentId: document.id,
      sapDocumentId,
      remarks: `Viewed SAP document ${sapDocumentId}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    res.setHeader("Content-Type", file.contentType);
    res.send(file.buffer);
  } catch (error) {
    console.error(error);
    // ✅ 404 use karo jab file na mile, 500 sirf genuine server errors ke liye
    const isMissingFile = error.message.includes("No physical files linked");
    res.status(isMissingFile ? 404 : 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── Download ─────────────────────────────────────────────────
// Same rule as viewDocument: FREE tenants always get the local
// watermarked copy, regardless of sapDocumentId presence.
const downloadDocument = async (req, res) => {
  try {
    const { Document } = req.models;
    const document = await Document.findOne({
      where: {
        id: req.params.id,

        tenantId: req.user.tenantId,

        status: "ACTIVE",
      },
    });

    if (!document) {
      return res.status(404).json({
        success: false,

        message: "Document not found",
      });
    }

    // ── Subscription Management System: FREE tenants download the
    // locally stored, dynamically watermarked copy — never SAP.
    if (isFreeTenant(req)) {
      if (!document.localFilePath || !fs.existsSync(document.localFilePath)) {
        return res.status(404).json({ success: false, message: "Document not found" });
      }

      const buffer = await fsPromises.readFile(document.localFilePath);
      const watermarked = await WatermarkService.watermark(buffer, document.mimeType);

      await AuditService.log({
        req,
        module: AUDIT_MODULES.DOCUMENT,
        action: AUDIT_ACTIONS.DOCUMENT_DOWNLOAD,
        documentId: document.id,
        remarks: `Downloaded (watermarked) "${document.originalFileName}"`,
        status: AUDIT_STATUS.SUCCESS,
      });

      res.setHeader("Content-Type", document.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${document.originalFileName}"`);
      return res.send(watermarked);
    }

    // ── DB-backed SAP Content API storage ─────────────────────
    // See the identical branch (with full rationale) in viewDocument
    // above. SAP_CONTENT_API documents are never fetched from SAP here.
    if (document.sourceType === "SAP_CONTENT_API") {
      const contentRow = await documentContentService.getDocumentContent({
        models: req.models,
        documentId: document.id,
      });
      if (!contentRow) {
        return res.status(404).json({ success: false, message: "Document not found" });
      }

      await AuditService.log({
        req,
        module: AUDIT_MODULES.DOCUMENT,
        action: AUDIT_ACTIONS.DOCUMENT_DOWNLOAD,
        documentId: document.id,
        sapDocumentId: document.sapDocumentId,
        remarks: `Downloaded DB-backed SAP Content API document "${document.originalFileName}"`,
        status: AUDIT_STATUS.SUCCESS,
      });

      res.setHeader("Content-Type", document.mimeType || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${document.originalFileName}"`
      );
      return res.send(contentRow.content);
    }

    if (!document.sapDocumentId) {
      return res.status(400).json({
        success: false,
        message: "This document has no SAP reference (upload may have failed)",
      });
    }

    const erpConfig = await getErpConfigForTenant(req.user.tenantId, req.masterModels);

    const erpService = ErpFactory.getService(erpConfig);

    const file = await erpService.getDocumentBinary(
      erpConfig,
      document.sapDocumentId,
    );

    // ── Audit: document downloaded ────────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT,
      action: AUDIT_ACTIONS.DOCUMENT_DOWNLOAD,
      documentId: document.id,
      sapDocumentId: document.sapDocumentId,
      remarks: `Downloaded "${document.originalFileName}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    res.setHeader("Content-Type", file.contentType);

    res.setHeader(
      "Content-Disposition",

      `attachment; filename="${document.originalFileName}"`,
    );

    res.send(file.buffer);
  } catch (error) {
    res.status(500).json({
      success: false,

      message: error.message,
    });
  }
};

// ── Thumbnail ────────────────────────────────────────────────
// Subscription Management System: small preview image, generated on the
// fly (never cached to disk as a separate artifact). FREE tenants get the
// same tiled watermark as /view and /download, applied AFTER downscaling
// so it stays legible at thumbnail size; PAID tenants get a clean preview,
// unchanged in spirit from the rest of the PAID flow (fetched from SAP).
const getDocumentThumbnail = async (req, res) => {
  try {
    const { Document } = req.models;
    const document = await Document.findOne({
      where: { id: req.params.id, tenantId: req.user.tenantId, status: "ACTIVE" },
    });

    if (!document) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    let sourceBuffer;
    let mimeType = document.mimeType;

    if (isFreeTenant(req)) {
      if (!document.localFilePath || !fs.existsSync(document.localFilePath)) {
        return res.status(404).json({ success: false, message: "Document not found" });
      }
      sourceBuffer = await fsPromises.readFile(document.localFilePath);
    } else {
      // ── DB-backed SAP Content API storage ───────────────────
      // Same rationale as the identical branch in viewDocument/
      // downloadDocument above: this document's binary lives in our own
      // DocumentContent table, not SAP's Content Server.
      if (document.sourceType === "SAP_CONTENT_API") {
        const contentRow = await documentContentService.getDocumentContent({
          models: req.models,
          documentId: document.id,
        });
        if (!contentRow) {
          return res.status(404).json({ success: false, message: "Document not found" });
        }
        sourceBuffer = contentRow.content;
        mimeType = document.mimeType || mimeType;
      } else {
        if (!document.sapDocumentId) {
          return res.status(400).json({
            success: false,
            message: "This document has no SAP reference (upload may have failed)",
          });
        }
        const erpConfig = await getErpConfigForTenant(req.user.tenantId, req.masterModels);
        const erpService = ErpFactory.getService(erpConfig);
        const file = await erpService.getDocumentBinary(erpConfig, document.sapDocumentId);
        sourceBuffer = file.buffer;
        mimeType = file.contentType || mimeType;
      }
    }

    let thumbnail;
    try {
      thumbnail = await ThumbnailService.generate(sourceBuffer, mimeType);
    } catch (thumbErr) {
      // Unsupported type (e.g. .docx) — no thumbnail available.
      return res.status(415).json({ success: false, message: thumbErr.message });
    }

    if (isFreeTenant(req)) {
      thumbnail = await WatermarkService.watermark(thumbnail, "image/png");
    }

    res.setHeader("Content-Type", "image/png");
    return res.send(thumbnail);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getDocumentVersions = async (req, res) => {
  try {
    const { Document, User } = req.models;
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    const doc = await Document.findOne({
      where: { id, tenantId, status: "ACTIVE" },
    });

    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Document not found" });
    }

    // Root ID nikalo — agar yeh khud root hai toh apna id, warna parent ka
    const rootId = doc.parentDocumentId || doc.id;
    const { Op } = require("sequelize");

    const versions = await Document.findAll({
      where: {
        [Op.or]: [{ id: rootId }, { parentDocumentId: rootId }],
        status: "ACTIVE",
      },
      include: [{ model: User, as: "uploader", attributes: ["id", "email"] }],
      order: [["version", "DESC"]],
    });

    return res.json({ success: true, data: versions });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
// ── Universal document search ─────────────────────────────────
// GET /api/documents/search?q=...&page=&limit=&departmentId=&categoryId=
//     &documentTypeId=&uploadStatus=&sourceType=&dateFrom=&dateTo=
//
// Tenant-wide, DB-side keyword search across document columns, both OCR
// text locations, and all dynamic metadata JSON. See
// services/documentSearchService.js for the full implementation notes.
// This handler stays thin on purpose (controller -> service -> model).
const searchDocuments = async (req, res) => {
  try {
    const tenantId = req.user.tenantId; // NEVER req.query.tenantId
    const {
      q,
      page,
      limit,
      departmentId,
      categoryId,
      documentTypeId,
      uploadStatus,
      sourceType,
      dateFrom,
      dateTo,
    } = req.query;

    const result = await documentSearchService.searchDocuments({
      models: req.models,
      masterModels: req.masterModels,
      tenantId,
      userId: req.user.id,
      role: req.user.role,
      query: q,
      filters: { departmentId, categoryId, documentTypeId, uploadStatus, sourceType, dateFrom, dateTo },
      page,
      limit,
    });

    return res.json({ success: true, data: result.data, pagination: result.pagination });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};
const searchAdvanced = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { q, tcode, poNumber, uploadStatus, departmentId, categoryId, documentTypeId, fromDate, toDate, page, limit } = req.query;

    const result = await documentSearchService.advancedSearch({
      models: req.models,
      masterModels: req.masterModels,
      tenantId,
      userId: req.user.id,
      role: req.user.role,
      filters: { q, tcode, poNumber, uploadStatus, departmentId, categoryId, documentTypeId, fromDate, toDate },
      page,
      limit,
    });

    return res.json({ success: true, data: result.data, total: result.total, page: result.page, totalPages: result.totalPages });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

module.exports = {
  uploadDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  getDocumentFromSap,
  getDocumentStatus,
  reprocessOcr,
  generateTcode,
  finalizeDocument,
  getDocumentActivity,
  searchByTcode,
  searchDocuments,
  searchAdvanced,
  viewDocument,
  downloadDocument,
  getDocumentThumbnail,
  getDocumentVersions,
}; 