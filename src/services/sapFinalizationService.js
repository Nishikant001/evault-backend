// src/services/sapFinalizationService.js
//
// The actual "push this document to SAP" logic, extracted so it can be
// called from two places without duplicating it:
//   1. documentController.finalizeDocument — the existing manual endpoint,
//      used as-is for documents whose DocumentType has NO approval
//      workflow configured (100% unchanged behavior).
//   2. approvalEngineService — invoked automatically the moment the FINAL
//      approval level is approved. SAP upload must happen ONLY after
//      final approval, never before.
//
// This file intentionally duplicates the small getErpConfigForTenant
// helper that already lives in documentController.js rather than
// refactoring/exporting it from there — the brief requires existing
// working files to be left untouched wherever avoidable.
const fs = require("fs");
const { getTenantConnection } = require("./tenantConnectionManager");
const { Tenant, ErpConfig, Department } = require("../models/masterDb");
const ErpFactory = require("./erpFactory");
const AuditService = require("./auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

async function getErpConfigForTenant(tenantId) {
  const tenant = await Tenant.findByPk(tenantId, {
    include: [{ model: ErpConfig }],
  });

  if (!tenant || !tenant.ErpConfig) {
    throw new Error("ERP configuration not assigned to tenant");
  }

  return tenant.ErpConfig;
}

/**
 * Uploads a document's binary + metadata to SAP and marks it COMPLETED.
 * Mirrors the exact steps previously inline in documentController's
 * finalizeDocument, so the response contract for non-approval documents
 * is unchanged.
 *
 * @param {object} document - a Document instance, ideally loaded with
 *        { include: [{ model: DocumentType, include: [{ model: Category, include: [{ model: Department }] }] }] }
 * @param {import('express').Request} [req] - optional, for audit context
 * @returns {Promise<{ sapDocumentId: string, sapPhioId: string }>}
 */
async function finalizeDocumentToSap(document, req) {
  // Re-fetch with the associations this function needs if the caller
  // passed a "bare" Document instance without them.
    let departmentRow = null;

  if (!document.DocumentType) {
    const { models: tenantModels } = await getTenantConnection(document.tenantId);
    document = await tenantModels.Document.findByPk(document.id, {
      include: [
        {
          model: tenantModels.DocumentType,
          include: [{ model: tenantModels.Category }],
        },
      ],
    });
  }

  // Department is a Master DB (global) master — Category only stores its
  // departmentId, so it has to be fetched separately (cross-DB, can't be
  // Sequelize-included from the tenant connection).
  const departmentId = document.DocumentType?.Category?.departmentId;
  if (departmentId) {
    departmentRow = await Department.findByPk(departmentId);
  }

  const logs = document.activityLogs || [];

  logs.push({
    message: "Saving document to SAP...",
    status: "PROCESSING",
    timestamp: new Date(),
  });

  await document.update({ activityLogs: logs, uploadStatus: "SAVING_TO_SAP" });

  const buffer = fs.readFileSync(document.tempFilePath);
  const erpConfig = await getErpConfigForTenant(document.tenantId);
  const erpService = ErpFactory.getService(erpConfig);

       const docMeta = {
    documentTypeName: document.DocumentType?.name || "N/A",
    categoryName: document.DocumentType?.Category?.name || "N/A",
    departmentName: departmentRow?.name || "N/A",
    docTypeCode: document.DocumentType?.sapCode || "",
    categoryCode: document.DocumentType?.Category?.sapCode || "",
    departmentCode: departmentRow?.sapCode || "",
    tcode: document.tcode || "",
    path: document.tempFilePath,
    version: document.version,
  };

  let sapData;
  try {
    sapData = await erpService.uploadDocumentToSap(
      erpConfig,
      buffer,
      document.mimeType,
      document.originalFileName,
      docMeta
    );
  } catch (sapError) {
    await AuditService.log({
      req,
      module: AUDIT_MODULES.SAP,
      action: AUDIT_ACTIONS.SAP_UPLOAD_FAILED,
      documentId: document.id,
      department: docMeta.departmentName,
      status: AUDIT_STATUS.FAILED,
      remarks: `SAP upload failed for document ${document.id}: ${sapError.message}`,
    });
    throw sapError;
  }

  logs.push({
    message: "SAP document created successfully",
    status: "SUCCESS",
    timestamp: new Date(),
  });
  logs.push({
    message: "Linking SAP references...",
    status: "SUCCESS",
    timestamp: new Date(),
  });
  logs.push({
    message: "Document archived successfully",
    status: "SUCCESS",
    timestamp: new Date(),
  });

  await document.update({
    sapDocumentId: sapData.documentId,
    sapPhioId: sapData.phioId,
    uploadStatus: "COMPLETED",
    activityLogs: logs,
  });

  if (fs.existsSync(document.tempFilePath)) {
    fs.unlinkSync(document.tempFilePath);
  }

  await AuditService.log({
    req,
    module: AUDIT_MODULES.SAP,
    action: AUDIT_ACTIONS.SAP_UPLOAD,
    documentId: document.id,
    sapDocumentId: sapData.documentId,
    department: docMeta.departmentName,
    newValue: { sapDocumentId: sapData.documentId, sapPhioId: sapData.phioId },
    remarks: `Document ${document.id} saved to SAP successfully`,
    status: AUDIT_STATUS.SUCCESS,
  });

  return { sapDocumentId: sapData.documentId, sapPhioId: sapData.phioId };
}

module.exports = { finalizeDocumentToSap, getErpConfigForTenant };
