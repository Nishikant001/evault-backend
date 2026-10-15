// src/models/tenantModels/Document.js
// PHASE B — factory version. Exports a function (sequelize) => Model,
// so this can be instantiated against ANY tenant's Sequelize connection
// instead of a single shared singleton. Field definitions below are
// byte-for-byte unchanged from the legacy src/models/Document.js — only
// the require/export wrapper differs.
const { DataTypes } = require("sequelize");

// We NEVER store the binary here.
// Binary → SAP Content Server
// Metadata + SAP reference IDs → this table
module.exports = (sequelize) => sequelize.define(
  "Document",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    // ── Hierarchy ──────────────────────────────────────────
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // NOTE on nullability: departmentId/categoryId/documentTypeId were
    // originally allowNull:false. The local-upload flow in
    // documentController.uploadDocument ALWAYS resolves and supplies all
    // three before calling Document.create, so relaxing this to nullable
    // changes nothing for that flow. It is required for SAP Document
    // Synchronization: when an inbound SAP DocumentMetaSet record's
    // DepartmentCode/CategoryCode/DocumentTypeCode cannot be resolved
    // against local master data yet, the brief requires the document to
    // still be stored (with sapSyncStatus = PENDING_CLASSIFICATION below)
    // rather than dropped — which is only possible if these columns can
    // temporarily be null.
    departmentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    categoryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "categories", key: "id" },
    },
    documentTypeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "document_types", key: "id" },
    },

    // ── Uploader ───────────────────────────────────────────
    // Also relaxed to nullable: SAP-synced documents have no local
    // uploader. The local-upload flow always supplies uploadedBy = req.user.id,
    // so this is a no-op change for that path.
    uploadedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },

    // ── File info ──────────────────────────────────────────
    originalFileName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    // Relaxed to nullable: the local-upload flow always supplies this from
    // the uploaded file (unchanged behavior). SAP Document Synchronization
    // only has DocumentMetaSet metadata, which does not always carry a
    // MIME type — the binary is fetched separately, on demand, via the
    // existing /:id/sap and /:id/download routes.
    mimeType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    fileSizeBytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    // ── SAP Content Server references ──────────────────────
    // Dual purpose, unchanged column: for LOCAL_UPLOAD documents this is
    // assigned by SAP at upload time (as before); for SAP_SYNC documents
    // (SAP Document Synchronization) it is the ORIGINAL SAP Document ID
    // read from DocumentMetaSet, and is the idempotency key the sync
    // engine upserts on ("if sapDocumentId exists UPDATE else INSERT").
    // Unique so two DocumentMetaSet sync passes can never create duplicate
    // rows for the same SAP document.
    sapDocumentId: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
      comment: "DocumentId returned by SAP GenerateUploadUrl, or the original SAP DocumentMetaSet Documentid for synced documents",
    },
        sapPhioId: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "PHIOId returned by SAP GenerateUploadUrl",
    },
    erpConfigId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    // ── SAP Document Synchronization ────────────────────────
  sourceType: {
  type: DataTypes.ENUM(
    "LOCAL_UPLOAD",
    "SAP_SYNC",
    "SAP_CONTENT_API"
  ),
  allowNull: false,
  defaultValue: "LOCAL_UPLOAD",
  comment:
    "LOCAL_UPLOAD = created via portal upload; SAP_SYNC = imported from SAP DocumentMetaSet; SAP_CONTENT_API = binary uploaded by SAP into the DMS content repository",
},
    sapSyncStatus: {
      type: DataTypes.ENUM("SYNCED", "PENDING_CLASSIFICATION", "FAILED"),
      allowNull: true,
      comment: "Only meaningful for sourceType=SAP_SYNC. PENDING_CLASSIFICATION means DepartmentCode/CategoryCode/DocumentTypeCode could not be resolved to local master data yet.",
    },
    sapRawDepartmentCode: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Unresolved SAP DepartmentCode from DocumentMetaSet, kept so reclassification can retry once master data catches up",
    },
    sapRawCategoryCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    sapRawDocumentTypeCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    sapMetaSyncedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "Last time SAP Document Synchronization wrote to this row",
    },

    // ── Upload status ──────────────────────────────────────
   uploadStatus: {
    type: DataTypes.ENUM(
      "UPLOADING",
      "OCR_PROCESSING",
      "OCR_COMPLETED",
      "WAITING_FOR_APPROVAL",
      "SAVING_TO_SAP",
      "COMPLETED",
      "FAILED",
      "REJECTED"
    ),
    defaultValue: "UPLOADING"
},
ocrMetadata: {
    type: DataTypes.JSON,
    allowNull: true
},
activityLogs: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: []
},

tcode: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true
},


tempFilePath: {
    type: DataTypes.STRING,
    allowNull: true
},

// Subscription Management System — permanent local storage path for
// FREE-tenant documents (never uploaded to SAP). See
// migrations/20260803010700-add-local-file-path-to-documents.js and
// services/localFinalizationService.js. Null for PAID/SAP-backed docs.
localFilePath: {
    type: DataTypes.STRING,
    allowNull: true
},

    // ── Custom metadata filled by uploader ─────────────────
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "Key-value pairs defined by DocumentType.metadataSchema",
    },

    status: {
      type: DataTypes.ENUM("ACTIVE", "ARCHIVED", "DELETED"),
      defaultValue: "ACTIVE",
    },
    parentDocumentId: {
  type: DataTypes.INTEGER,
  allowNull: true,
  references: { model: "documents", key: "id" },
},
version: {
  type: DataTypes.INTEGER,
  allowNull: false,
  defaultValue: 1,
},

    // ── Enterprise Check-In / Check-Out lock ────────────────
    // Lock state always lives on the ROOT document of a version family
    // (parentDocumentId === null) — see checkInOutService.resolveRoot.
    isCheckedOut: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    checkedOutBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    checkedOutAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lockReason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Reason supplied by the user at check-out time",
    },
    lockExpiry: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "Optional expected-return date supplied at check-out",
    },
    checkedInBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    checkedInAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    checkInComments: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    forceUnlockedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
      comment: "TenantAdmin/DeptHead who forcibly released someone else's lock",
    },
    forceUnlockedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    forceUnlockReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  
  {
    tableName: "documents",
    timestamps: true,
  }
);

