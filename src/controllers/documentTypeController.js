const { Op } = require("sequelize");
// PHASE G — DocumentType/Category are tenant-side models.
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const userAssignmentService = require("../services/userAssignmentService");

// ── Create a document type under a category ─────────────────
const createDocumentType = async (req, res) => {
  try {
    const { DocumentType, Category } = req.models;
    const { categoryId, name, description, allowedMimeTypes, metadataSchema } =
      req.body;
    const tenantId = req.user.tenantId;

    if (!categoryId || !name) {
      return res.status(400).json({
        success: false,
        message: "categoryId and name are required",
      });
    }

    // Verify category belongs to this tenant
    const category = await Category.findOne({
      where: { id: categoryId, tenantId, status: "ACTIVE" },
    });
    if (!category) {
      return res.status(403).json({
        success: false,
        message: "Category not found or does not belong to your tenant",
      });
    }

    const docType = await DocumentType.create({
      tenantId,
      categoryId,
      name: name.trim(),
      description,
      allowedMimeTypes,
      metadataSchema,
    });

    // ── Audit: document type created ────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT_TYPE,
      action: AUDIT_ACTIONS.DOCUMENT_TYPE_CREATED,
      newValue: { id: docType.id, name: docType.name, categoryId },
      remarks: `Created document type "${docType.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({ success: true, data: docType });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({
        success: false,
        message: "Document type with this name already exists in this category",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── List document types for tenant (filter by category) ─────
const listDocumentTypes = async (req, res) => {
  try {
    const { DocumentType, Category } = req.models;
    const tenantId = req.user.tenantId;
    const { categoryId } = req.query;

    const where = { tenantId, status: "ACTIVE" };
    if (categoryId) where.categoryId = categoryId;

    // ── Dynamic User Assignment Engine: auto-filter to allowed doc types
    const scope = await userAssignmentService.resolveScope(
      req.models,
      tenantId,
      req.user.id,
      req.user.role
    );
    if (scope) {
      if (!scope.documentTypeIds.length) {
        return res.json({ success: true, data: [] });
      }
      where.id = { [Op.in]: scope.documentTypeIds };
    }

    const docTypes = await DocumentType.findAll({
      where,
      include: [{ model: Category, attributes: ["id", "name", "departmentId"] }],
      order: [["name", "ASC"]],
    });

    return res.json({ success: true, data: docTypes });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Get single document type (used before upload to get schema) ─
const getDocumentType = async (req, res) => {
  try {
    const { DocumentType, Category } = req.models;
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    const docType = await DocumentType.findOne({
      where: { id, tenantId, status: "ACTIVE" },
      include: [{ model: Category }],
    });
    if (!docType) {
      return res.status(404).json({ success: false, message: "Document type not found" });
    }

    const allowed = await userAssignmentService.hasDocumentTypeAccess(
      req.models,
      tenantId,
      req.user.id,
      req.user.role,
      docType.id
    );
    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this document type",
      });
    }

    return res.json({ success: true, data: docType });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Update a document type ───────────────────────────────────
const updateDocumentType = async (req, res) => {
  try {
    const { DocumentType, Category } = req.models;
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    const docType = await DocumentType.findOne({ where: { id, tenantId } });
    if (!docType) {
      return res.status(404).json({ success: false, message: "Document type not found" });
    }

    const oldValue = docType.toJSON();
    await docType.update(req.body);

    // ── Audit: document type updated ────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT_TYPE,
      action: AUDIT_ACTIONS.DOCUMENT_TYPE_UPDATED,
      oldValue,
      newValue: docType.toJSON(),
      remarks: `Updated document type "${docType.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: docType });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── Delete (soft) ────────────────────────────────────────────
const deleteDocumentType = async (req, res) => {
  try {
    const { DocumentType, Category } = req.models;
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    const docType = await DocumentType.findOne({ where: { id, tenantId } });
    if (!docType) {
      return res.status(404).json({ success: false, message: "Document type not found" });
    }

    await docType.update({ status: "INACTIVE" });

    // ── Audit: document type deleted ────────────────────────
    await AuditService.log({
      req,
      module: AUDIT_MODULES.DOCUMENT_TYPE,
      action: AUDIT_ACTIONS.DOCUMENT_TYPE_DELETED,
      oldValue: { status: "ACTIVE" },
      newValue: { status: "INACTIVE" },
      remarks: `Deleted document type "${docType.name}"`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, message: "Document type deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createDocumentType,
  listDocumentTypes,
  getDocumentType,
  updateDocumentType,
  deleteDocumentType,
};