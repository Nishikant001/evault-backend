// src/controllers/sapSyncExtController.js
//
// Extends the SAP Master/Document Synchronization module (sapSyncController.js
// owns the 6 original run/status/logs endpoints) with the read/write APIs the
// SAP Synchronization frontend module needs: per-record master & document
// listings, the Document Details modal, Pending Classification, Scheduler
// Management, and Settings. Kept in a separate file so the original
// controller (and its existing tests/behaviour) stays untouched.

const { Op } = require("sequelize");
// PHASE G — Tenant/ErpConfig/Department/TenantDepartment are Master DB
// models (req.masterModels). Category/DocumentType/Document/SapSyncLog/
// SapSyncRetryQueue/SapSyncSchedule/SapSyncSettings are tenant-side.
// resolveTenantId() below lets SuperAdmin target an arbitrary tenant (not
// their own — SuperAdmin has no req.models), so tenant-side models are
// resolved per-request via getTenantConnection(tenantId) rather than
// req.models. Any place that used to `include: [{ model: Department }]`
// on a tenant-side model is a cross-database join Sequelize can't do
// anymore — split into two queries and merged in JS (hydrateDepartments()).
const SapService = require("../services/sapService");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const Scheduler = require("../services/sapSyncScheduler");
const ErpFactory = require("../services/erpFactory");
const { getTenantConnection } = require("../services/tenantConnectionManager");

async function hydrateDepartments(masterModels, docOrDocs) {
  const list = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
  const ids = [...new Set(list.map((d) => d?.departmentId).filter(Boolean))];
  if (!ids.length) return docOrDocs;
  const departments = await masterModels.Department.findAll({
    where: { id: ids },
    attributes: ["id", "name", "code"],
    raw: true,
  });
  const byId = new Map(departments.map((d) => [d.id, d]));
  for (const d of list) {
    if (d) d.Department = d.departmentId ? byId.get(d.departmentId) || null : null;
  }
  return docOrDocs;
}

function resolveTenantId(req) {
  if (req.user.role === "SuperAdmin") {
    const tenantId = req.body?.tenantId || req.query?.tenantId;
    return tenantId ? parseInt(tenantId, 10) : null;
  }
  return req.user.tenantId;
}

function pagination(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 200);
  return { page, limit, offset: (page - 1) * limit };
}

function deriveMasterStatus(row) {
  if (!row.sapCode) return "PENDING";
  return "MAPPED";
}

// ── GET /api/sap-sync/masters/:type ──────────────────────────
// type: departments | categories | document-types
// Query: page, limit, search, status (MAPPED|PENDING|ERROR)
const listMasters = async (req, res) => {
  try {
    const { type } = req.params;
    if (!["departments", "categories", "document-types"].includes(type)) {
      return res.status(400).json({ success: false, message: "type must be one of: departments, categories, document-types" });
    }
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });

    const { Department, TenantDepartment } = req.masterModels;
    const { Category, DocumentType } = (await getTenantConnection(tenantId)).models;
    const Model = { departments: Department, categories: Category, "document-types": DocumentType }[type];

    const { search, status, departmentId, categoryId } = req.query;
    const { page, limit, offset } = pagination(req.query);

        let rows, count;

    if (type === "departments") {
      // Global master — scoped to what's assigned to this tenant.
      const where = { status: "ACTIVE" };
      if (search) {
        where[Op.or] = [
          { name: { [Op.like]: `%${search}%` } },
          { sapCode: { [Op.like]: `%${search}%` } },
          { code: { [Op.like]: `%${search}%` } },
        ];
      }
      if (status === "MAPPED") where.sapCode = { [Op.ne]: null };
      if (status === "PENDING") where.sapCode = null;

      const { count: total, rows: assignments } = await TenantDepartment.findAndCountAll({
        where: { tenantId, status: "ACTIVE" },
        include: [{ model: Department, where, required: true }],
        limit,
        offset,
        order: [[Department, "name", "ASC"]],
      });
      count = total;
      // erpConfigId lives on the TenantDepartment assignment, not on the
      // shared global Department row — merge it in.
      rows = assignments.map((a) => ({
        ...a.Department.get({ plain: true }),
        erpConfigId: a.erpConfigId,
      }));
    } else {
      const where = { tenantId, status: "ACTIVE" };
      if (search) {
        where[Op.or] = [
          { name: { [Op.like]: `%${search}%` } },
          { sapCode: { [Op.like]: `%${search}%` } },
        ];
      }
      if (status === "MAPPED") where.sapCode = { [Op.ne]: null };
      if (status === "PENDING") where.sapCode = null;
      if (type === "categories" && departmentId) where.departmentId = departmentId;
      if (type === "document-types" && categoryId) where.categoryId = categoryId;

      const result = await Model.findAndCountAll({ where, limit, offset, order: [["name", "ASC"]] });
      rows = result.rows;
      count = result.count;
    }

    const erpConfigIds = [...new Set(rows.map((r) => r.erpConfigId).filter(Boolean))];
    const erpConfigs = erpConfigIds.length
      ? await req.masterModels.ErpConfig.findAll({ where: { id: erpConfigIds }, attributes: ["id", "name"], raw: true })
      : [];
    const erpConfigMap = Object.fromEntries(erpConfigs.map((e) => [e.id, e.name]));

    const data = rows.map((r) => ({
      id: r.id,
      sapCode: r.sapCode,
      localName: r.name,
      localId: r.id,
      syncStatus: deriveMasterStatus(r),
      lastSyncTime: r.lastSyncedAt,
      source: r.sapCode ? "SAP" : "LOCAL",
      erpSourceName: erpConfigMap[r.erpConfigId] || null,
      ...(type === "categories" ? { departmentId: r.departmentId } : {}),
      ...(type === "document-types" ? { categoryId: r.categoryId } : {}),
    }));

    return res.json({
      success: true,
      data,
      pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) || 1 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── GET /api/sap-sync/documents ──────────────────────────────
// Query: page, limit, departmentId, categoryId, documentTypeId, sapSyncStatus,
//        classification (COMPLETE|PENDING), sapDocumentId, dateFrom, dateTo
const listSyncDocuments = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { Document, Category, DocumentType, SapSyncRetryQueue } = (await getTenantConnection(tenantId)).models;

    const {
      departmentId,
      categoryId,
      documentTypeId,
      sapSyncStatus,
      classification,
      sapDocumentId,
      dateFrom,
      dateTo,
    } = req.query;
    const { page, limit, offset } = pagination(req.query);

    const where = { tenantId, sourceType: "SAP_SYNC" };
    if (departmentId) where.departmentId = departmentId;
    if (categoryId) where.categoryId = categoryId;
    if (documentTypeId) where.documentTypeId = documentTypeId;
    if (sapSyncStatus) where.sapSyncStatus = sapSyncStatus;
    if (sapDocumentId) where.sapDocumentId = { [Op.like]: `%${sapDocumentId}%` };
    if (classification === "PENDING") {
      where[Op.or] = [{ departmentId: null }, { categoryId: null }, { documentTypeId: null }];
    } else if (classification === "COMPLETE") {
      where.departmentId = { [Op.ne]: null };
      where.categoryId = { [Op.ne]: null };
      where.documentTypeId = { [Op.ne]: null };
    }
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt[Op.gte] = new Date(dateFrom);
      if (dateTo) where.createdAt[Op.lte] = new Date(dateTo);
    }

    const { rows, count } = await Document.findAndCountAll({
      where,
      include: [
        { model: Category, attributes: ["id", "name"], required: false },
        { model: DocumentType, attributes: ["id", "name"], required: false },
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });
        await hydrateDepartments(req.masterModels, rows.map((r) => r.dataValues));

    const erpConfigIds = [...new Set(rows.map((r) => r.erpConfigId).filter(Boolean))];
    const erpConfigs = erpConfigIds.length
      ? await req.masterModels.ErpConfig.findAll({ where: { id: erpConfigIds }, attributes: ["id", "name"], raw: true })
      : [];
    const erpConfigMap = Object.fromEntries(erpConfigs.map((e) => [e.id, e.name]));

    const sapDocIds = rows.map((r) => r.sapDocumentId).filter(Boolean);
    const retryCounts = sapDocIds.length
      ? await SapSyncRetryQueue.findAll({
          where: { tenantId, entityType: "DOCUMENT", referenceCode: { [Op.in]: sapDocIds } },
          attributes: ["referenceCode", "attempts"],
        })
      : [];
    const retryMap = Object.fromEntries(retryCounts.map((r) => [r.referenceCode, r.attempts]));

    const data = rows.map((d) => ({
      id: d.id,
      sapDocumentId: d.sapDocumentId,
      department: d.dataValues.Department?.name || d.sapRawDepartmentCode || "—",
      category: d.Category?.name || d.sapRawCategoryCode || "—",
      documentType: d.DocumentType?.name || d.sapRawDocumentTypeCode || "—",
      originalFilename: d.originalFileName || null,
      hasOriginal: d.sourceType === "SAP_SYNC" || !!d.sapPhioId,
      classificationStatus:
        d.departmentId && d.categoryId && d.documentTypeId ? "COMPLETE" : "PENDING",
      mappedStatus: d.departmentId && d.categoryId && d.documentTypeId ? "MAPPED" : "UNMAPPED",
           importDate: d.createdAt,
      erpSource: erpConfigMap[d.erpConfigId] || "—",
      syncStatus: d.sapSyncStatus,
      retryCount: retryMap[d.sapDocumentId] || 0,
    }));

    return res.json({
      success: true,
      data,
      pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) || 1 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── GET /api/sap-sync/documents/:id ──────────────────────────
const getSyncDocumentDetail = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const { id } = req.params;
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { Document, Category, DocumentType, SapSyncLog, SapSyncRetryQueue } = (await getTenantConnection(tenantId)).models;
    const doc = await Document.findOne({
      where: { id, tenantId },
      include: [
        { model: Category, attributes: ["id", "name"], required: false },
        { model: DocumentType, attributes: ["id", "name"], required: false },
      ],
    });
    if (!doc) return res.status(404).json({ success: false, message: "Document not found" });
    const docPlain = doc.toJSON();
    await hydrateDepartments(req.masterModels, docPlain);

    const retryHistory = doc.sapDocumentId
      ? await SapSyncRetryQueue.findOne({
          where: { tenantId: doc.tenantId, entityType: "DOCUMENT", referenceCode: doc.sapDocumentId },
        })
      : null;

    const relatedLogs = await SapSyncLog.findAll({
      where: { tenantId: doc.tenantId, syncType: "DOCUMENT" },
      order: [["createdAt", "DESC"]],
      limit: 5,
      attributes: ["id", "status", "startTime", "endTime", "triggerType", "recordsCreated", "recordsUpdated", "recordsFailed"],
    });

    return res.json({
      success: true,
      data: {
        sapDocumentId: doc.sapDocumentId,
        department: doc.sapRawDepartmentCode,
        category: doc.sapRawCategoryCode,
        documentType: doc.sapRawDocumentTypeCode,
        originalFilename: doc.originalFileName,
        hasOriginal: doc.sourceType === "SAP_SYNC" || !!doc.sapPhioId,
        mappedDepartment: docPlain.Department?.name || null,
        mappedCategory: doc.Category?.name || null,
        mappedDocumentType: doc.DocumentType?.name || null,
        currentStatus: doc.sapSyncStatus,
        synchronizationHistory: relatedLogs,
        retryHistory: retryHistory
          ? { attempts: retryHistory.attempts, status: retryHistory.status, lastError: retryHistory.lastError, history: retryHistory.history }
          : null,
        rawMetadata: {
          sapPhioId: doc.sapPhioId,
          sapRawDepartmentCode: doc.sapRawDepartmentCode,
          sapRawCategoryCode: doc.sapRawCategoryCode,
          sapRawDocumentTypeCode: doc.sapRawDocumentTypeCode,
          sapMetaSyncedAt: doc.sapMetaSyncedAt,
          mimeType: doc.mimeType,
          createdAt: doc.createdAt,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── GET /api/sap-sync/pending-classification ─────────────────
const listPendingClassification = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { Document } = (await getTenantConnection(tenantId)).models;
    const { page, limit, offset } = pagination(req.query);

    const { rows, count } = await Document.findAndCountAll({
      where: {
        tenantId,
        sourceType: "SAP_SYNC",
        [Op.or]: [{ departmentId: null }, { categoryId: null }, { documentTypeId: null }],
      },
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    const data = rows.map((d) => {
      const missing = [];
      if (!d.departmentId) missing.push("Department");
      if (!d.categoryId) missing.push("Category");
      if (!d.documentTypeId) missing.push("DocumentType");
      return {
        id: d.id,
        sapDocumentId: d.sapDocumentId,
        filename: d.originalFileName || "—",
        missingFields: missing,
        reason: `Could not resolve: ${missing.join(", ")} from SAP code(s) ${[d.sapRawDepartmentCode, d.sapRawCategoryCode, d.sapRawDocumentTypeCode].filter(Boolean).join("/") || "N/A"}`,
        importedDate: d.createdAt,
        status: d.sapSyncStatus,
      };
    });

    return res.json({
      success: true,
      data,
      pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) || 1 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── GET /api/sap-sync/pending-classification/:id/view ────────
// Streams the original document binary so it can be previewed in the
// browser before Department/Category/DocumentType are assigned.
// Read-only addition — does not touch classification, sync, mapping,
// retry, scheduler, OCR, or import logic.
//
// Binary for SAP_SYNC documents is never stored locally (see Document
// model comment: "Binary → SAP Content Server"), so this reuses the same
// erpService.getDocumentBinary(...) call already used by
// documentController.viewDocument / downloadDocument — no new storage,
// no re-upload, no re-sync, no re-download.
const viewPendingClassificationDocument = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });

    const { id } = req.params;

    // Accept either our internal numeric id or the SAP Document ID shown
    // in the "SAP Document ID" column — whichever the caller has on hand.
    const numericId = Number(id);
    const lookupWhere = {
      tenantId,
      [Op.or]: [
        ...(Number.isInteger(numericId) && String(numericId) === String(id) ? [{ id: numericId }] : []),
        { sapDocumentId: String(id) },
      ],
    };

    const { Document } = (await getTenantConnection(tenantId)).models;
    const doc = await Document.findOne({ where: lookupWhere });

    // Tenant-scoped lookup: a document that exists but belongs to another
    // tenant resolves to "not found" here rather than leaking existence.
    if (!doc) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    if (!doc.sapDocumentId) {
      return res.status(404).json({ success: false, message: "Document file not found." });
    }

    const { Tenant, ErpConfig } = req.masterModels;
    const tenant = await Tenant.findByPk(tenantId, { include: [{ model: ErpConfig }] });
    if (!tenant || !tenant.ErpConfig) {
      return res.status(400).json({ success: false, message: "No ERP configuration assigned to this tenant" });
    }

    const erpService = ErpFactory.getService(tenant.ErpConfig);

    let file;
    try {
      file = await erpService.getDocumentBinary(tenant.ErpConfig, doc.sapDocumentId);
    } catch (fetchError) {
      const isMissingFile = /no physical files linked/i.test(fetchError.message || "");
      return res.status(isMissingFile ? 404 : 502).json({
        success: false,
        message: isMissingFile ? "Document file not found." : fetchError.message,
      });
    }

    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT,
      action: AUDIT_ACTIONS.DOCUMENT_VIEW,
      documentId: doc.id,
      sapDocumentId: doc.sapDocumentId,
      remarks: `Viewed "${doc.originalFileName}" from Pending Classification`,
      status: AUDIT_STATUS.SUCCESS,
    });

    // Inline, not attachment — lets the browser render PDFs (or any other
    // future document type) directly in the new tab instead of forcing a
    // download, while still allowing "Save As" for types it can't render.
    res.setHeader("Content-Type", file.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${(doc.originalFileName || "document").replace(/"/g, "")}"`);
    return res.send(file.buffer);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

async function applyClassification(doc, { departmentId, categoryId, documentTypeId }) {
  const updates = {};
  if (departmentId) updates.departmentId = departmentId;
  if (categoryId) updates.categoryId = categoryId;
  if (documentTypeId) updates.documentTypeId = documentTypeId;
  await doc.update(updates);
  if (doc.departmentId && doc.categoryId && doc.documentTypeId && doc.sapSyncStatus === "PENDING_CLASSIFICATION") {
    await doc.update({ sapSyncStatus: "SYNCED" });
  }
  return doc;
}

// ── POST /api/sap-sync/pending-classification/:id/assign ────
// Body: { departmentId?, categoryId?, documentTypeId? }
const assignClassification = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { Document } = (await getTenantConnection(tenantId)).models;
    const { id } = req.params;
    const doc = await Document.findOne({ where: { id, tenantId } });
    if (!doc) return res.status(404).json({ success: false, message: "Document not found" });

    await applyClassification(doc, req.body || {});

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action: AUDIT_ACTIONS.SAP_CLASSIFICATION_ASSIGNED,
      tenantId: doc.tenantId,
      newValue: { documentId: doc.id, ...req.body },
      remarks: `Manual classification assigned for SAP document ${doc.sapDocumentId}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: doc });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── POST /api/sap-sync/pending-classification/bulk-assign ───
// Body: { items: [{ id, departmentId?, categoryId?, documentTypeId? }] }
const bulkAssignClassification = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { Document } = (await getTenantConnection(tenantId)).models;
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "items array is required" });
    }

    const results = [];
    for (const item of items) {
      try {
        const doc = await Document.findOne({ where: { id: item.id, tenantId } });
        if (!doc) {
          results.push({ id: item.id, success: false, message: "Not found" });
          continue;
        }
        await applyClassification(doc, item);
        results.push({ id: item.id, success: true });
      } catch (err) {
        results.push({ id: item.id, success: false, message: err.message });
      }
    }

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action: AUDIT_ACTIONS.SAP_CLASSIFICATION_ASSIGNED,
      tenantId,
      newValue: { count: items.length },
      remarks: `Bulk classification mapping applied to ${items.length} document(s)`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: results });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Scheduler Management ─────────────────────────────────────

const DEFAULT_SCHEDULES = [
  { jobName: "MASTER_SYNC", label: "SAP Master Synchronization", cronExpression: "0 2 * * *" },
  { jobName: "DOCUMENT_SYNC", label: "SAP Document Synchronization", cronExpression: "0 3 * * *" },
  { jobName: "RETRY_SYNC", label: "Retry Failed Sync", cronExpression: "*/30 * * * *" },
];

async function ensureDefaultSchedules(SapSyncSchedule, tenantId) {
  for (const def of DEFAULT_SCHEDULES) {
    await SapSyncSchedule.findOrCreate({
      where: { tenantId, jobName: def.jobName },
      defaults: { ...def, tenantId },
    });
  }
}

// GET /api/sap-sync/schedules
const listSchedules = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { SapSyncSchedule } = (await getTenantConnection(tenantId)).models;
    await ensureDefaultSchedules(SapSyncSchedule, tenantId);
    const schedules = await SapSyncSchedule.findAll({ where: { tenantId }, order: [["jobName", "ASC"]] });

    // Retry-count column comes from the retry queue's abandoned/attempts for the relevant entity types.
    return res.json({ success: true, data: schedules });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/sap-sync/schedules/:id  — Body: { cronExpression?, enabled? }
const updateSchedule = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { SapSyncSchedule } = (await getTenantConnection(tenantId)).models;
    const { id } = req.params;
    const schedule = await SapSyncSchedule.findOne({ where: { id, tenantId } });
    if (!schedule) return res.status(404).json({ success: false, message: "Schedule not found" });

    const { cronExpression, enabled } = req.body || {};
    const updates = {};
    if (typeof cronExpression === "string" && cronExpression.trim()) updates.cronExpression = cronExpression.trim();
    if (typeof enabled === "boolean") updates.enabled = enabled;
    updates.updatedBy = req.user.id;
    await schedule.update(updates);

    Scheduler.reload(schedule.tenantId, schedule.jobName);

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action: AUDIT_ACTIONS.SAP_SCHEDULE_UPDATED,
      tenantId: schedule.tenantId,
      newValue: updates,
      remarks: `Schedule "${schedule.label}" updated`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: schedule });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/sap-sync/schedules/:id/run-now
const runScheduleNow = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const { SapSyncSchedule } = (await getTenantConnection(tenantId)).models;
    const { id } = req.params;
    const schedule = await SapSyncSchedule.findOne({ where: { id, tenantId } });
    if (!schedule) return res.status(404).json({ success: false, message: "Schedule not found" });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action: AUDIT_ACTIONS.SAP_SCHEDULE_RUN_NOW,
      tenantId: schedule.tenantId,
      remarks: `"${schedule.label}" triggered manually via Scheduler page`,
      status: AUDIT_STATUS.PENDING,
    });

    const result = await Scheduler.runJobNow(schedule.tenantId, schedule.jobName, req.user.id);

    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Settings ──────────────────────────────────────────────────

async function getOrCreateSettings(tenantId) {
  const { SapSyncSettings } = (await getTenantConnection(tenantId)).models;
  const [settings] = await SapSyncSettings.findOrCreate({ where: { tenantId }, defaults: { tenantId } });
  return settings;
}

// GET /api/sap-sync/settings
const getSettings = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const settings = await getOrCreateSettings(tenantId);
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const SETTINGS_FIELDS = [
  "autoSyncEnabled",
  "retryCount",
  "batchSize",
  "parallelJobs",
  "importOnlyHasOriginal",
  "pendingClassificationRule",
  "duplicateStrategy",
  "syncIntervalMinutes",
];

// PUT /api/sap-sync/settings
const updateSettings = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });
    const settings = await getOrCreateSettings(tenantId);

    const updates = {};
    for (const field of SETTINGS_FIELDS) {
      if (req.body?.[field] !== undefined) updates[field] = req.body[field];
    }
    updates.updatedBy = req.user.id;
    await settings.update(updates);

    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP_SYNC,
      action: AUDIT_ACTIONS.SAP_SETTINGS_UPDATED,
      tenantId,
      newValue: updates,
      remarks: "SAP Sync settings updated",
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/sap-sync/settings/test-connection
// MULTI-ERP FIX: this previously ALWAYS tested `tenant.ErpConfig` — the
// legacy single-ERP association — even when the Settings page had an
// explicit ERP selected and sent it as `erpConfigId` in the request body
// (SapSyncApi.testConnection(erpConfigId) has sent this all along; the
// controller just never read it). For a tenant with multiple active SAP
// ERP connections this meant "Connection Test" silently tested the
// wrong ERP whenever the selected one wasn't the tenant's default.
//
// Now:
//   - erpConfigId given -> verified to belong to this tenant (and be
//     active) via TenantErpConnection, then tested. Never silently
//     substitutes a different ERP.
//   - erpConfigId omitted -> falls back to the legacy tenant.ErpConfig
//     association, unchanged from before. Single-ERP tenants (the
//     common case, where the frontend selector is hidden and never
//     sends erpConfigId) see zero behavior change.
const testTenantConnection = async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ success: false, message: "tenantId is required" });

    const rawErpConfigId = req.body?.erpConfigId ?? req.query?.erpConfigId;
    const erpConfigId =
      rawErpConfigId !== undefined && rawErpConfigId !== null && rawErpConfigId !== ""
        ? parseInt(rawErpConfigId, 10)
        : undefined;

    let erpConfig;

    if (erpConfigId !== undefined) {
      if (!Number.isInteger(erpConfigId)) {
        return res.status(400).json({ success: false, message: "erpConfigId must be a valid integer" });
      }

      const { TenantErpConnection, ErpConfig } = req.masterModels;
      const connection = await TenantErpConnection.findOne({
        where: { tenantId, erpConfigId, isActive: true },
        include: [{ model: ErpConfig, as: "erpConfig", required: true }],
      });

      if (!connection) {
        return res.status(403).json({
          success: false,
          message: "The requested ERP configuration is not assigned to this tenant or is inactive",
        });
      }

      erpConfig = connection.erpConfig;
    } else {
      const { Tenant, ErpConfig } = req.masterModels;
      const tenant = await Tenant.findByPk(tenantId, { include: [{ model: ErpConfig }] });
      if (!tenant || !tenant.ErpConfig) {
        return res.status(400).json({ success: false, message: "No ERP configuration assigned to this tenant" });
      }
      erpConfig = tenant.ErpConfig;
    }

    // MULTI-ERP FIX: this resolved the CORRECT erpConfig (SAP, Oracle, or
    // Custom — whichever the tenant selected) above, but then always ran
    // it through SapService.testConnection() regardless of erpType. For a
    // non-SAP connection that meant "Test Connection" silently ran SAP's
    // CSRF/OData probe against, say, an Oracle REST endpoint and failed.
    // Route through ErpFactory like every other ERP-facing call.
    const erpService = ErpFactory.getService(erpConfig);
    await erpService.testConnection(erpConfig, () => {});
    await erpConfig.update({ status: "CONNECTED" });
    return res.json({ success: true, message: "Connection successful", data: { erpConfigId: erpConfig.id, erpConfigName: erpConfig.name } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

module.exports = {
  listMasters,
  listSyncDocuments,
  getSyncDocumentDetail,
  listPendingClassification,
  viewPendingClassificationDocument,
  assignClassification,
  bulkAssignClassification,
  listSchedules,
  updateSchedule,
  runScheduleNow,
  getSettings,
  updateSettings,
  testTenantConnection,
};