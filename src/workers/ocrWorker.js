// src/workers/ocrWorker.js
const OcrService = require("../services/ocrService");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

// Phase 5: this is a fire-and-forget background worker with no `req`
// (kicked off from documentController/checkInOutController with
// `processOCR(id, req.models)`, not awaited) — so unlike controllers/
// services, `models` MUST be passed explicitly here; there is no
// request to derive it from once this runs.
async function processOCR(documentId, models) {
  const { Document } = models;
  // Wait for DB transaction to commit
  await new Promise((resolve) => setTimeout(resolve, 1000));

  let document = null;

  try {
    // Retry up to 3 times in case of race condition
    for (let attempt = 1; attempt <= 3; attempt++) {
      document = await Document.findByPk(documentId);
      if (document) break;
      console.warn(`[OCR] Attempt ${attempt}: document ${documentId} not found, retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }

    if (!document) {
      console.error(`[OCR] Document ${documentId} not found after retries`);
      return;
    }

    if (!document.tempFilePath) {
      console.error(`[OCR] No tempFilePath on document ${documentId}`);
      await document.update({ uploadStatus: "FAILED" });
      return;
    }

    const logs = Array.isArray(document.activityLogs)
      ? [...document.activityLogs]
      : [];

    logs.push({
      message:   "OCR processing started...",
      status:    "PROCESSING",
      timestamp: new Date(),
    });
    await document.update({ activityLogs: logs });

    const metadata = await OcrService.process(document.tempFilePath);

    logs.push({
      message:   "OCR completed successfully",
      status:    "SUCCESS",
      timestamp: new Date(),
    });

    // NOTE: the old static Invoice-shaped field list (invoiceNumber,
    // poNumber, vendorName, ...) from OcrService.parseFields() is
    // intentionally NOT persisted anymore — the Dynamic Metadata
    // Template Engine (DocumentMetadata table, below) is now the single
    // source of truth for extracted fields. We still keep `extractedText`
    // here because documentIndexingService / vectorSearchService (AI
    // Document Assistant chat search) read it straight off
    // document.ocrMetadata.extractedText.
    await document.update({
      ocrMetadata:  { extractedText: metadata.extractedText },
      uploadStatus: "OCR_COMPLETED",
      activityLogs: logs,
    });

    console.log(`[OCR] Done for document ${documentId}`);

    // ── Dynamic Metadata Template Engine ───────────────────────
    // Best-effort, fully additive: if the Tenant Admin has published a
    // MetadataTemplate for this document's DocumentType, map the OCR text
    // into it and store the result in DocumentMetadata. If not (or if
    // anything here throws), the existing static `document.ocrMetadata`
    // set above is completely unaffected.
    try {
      const dynamicOcrMappingService = require("../services/dynamicOcrMappingService");
      await dynamicOcrMappingService.mapDocument({
        documentId: document.id,
        tenantId: document.tenantId,
        documentTypeId: document.documentTypeId,
        extractedText: metadata.extractedText,
        legacyFields: null, // static field list retired — see note above
      });
    } catch (dynamicMappingError) {
      console.error(
        `[OCR] Dynamic metadata mapping failed for document ${documentId}:`,
        dynamicMappingError.message
      );
    }

    // ── AI Document Assistant (RAG) — auto-index for chat/search ──────
    // Best-effort, fully additive: chunk + embed the extracted text and
    // store vectors so the document is immediately searchable in the AI
    // chatbot. Controlled per-tenant by AISettings.autoIndexOnUpload; any
    // failure here (e.g. no AI provider configured yet) never affects the
    // OCR/upload flow — it only leaves Embedding.status = FAILED, which the
    // tenant can retry later via POST /api/ai/documents/:id/reindex.
    try {
      const aiProviderService = require("../services/aiProviderService");
      const documentIndexingService = require("../services/documentIndexingService");
      const settings = await aiProviderService.getOrCreateSettings(document.tenantId);
      if (settings.isEnabled && settings.autoIndexOnUpload) {
        await documentIndexingService.indexDocument(document.tenantId, document.id);
      }
    } catch (indexError) {
      console.error(`[AI-Index] Auto-index failed for document ${documentId}:`, indexError.message);
    }

    // ── Audit: OCR completed ──────────────────────────────────
    // This is a background worker (no HTTP request), so ipAddress/browser/
    // device are not available — identity comes from the document record.
    await AuditService.log({
      models,
      userId: document.uploadedBy,
      tenantId: document.tenantId,
      module: AUDIT_MODULES.OCR,
      action: AUDIT_ACTIONS.OCR_COMPLETED,
      documentId: document.id,
      remarks: `OCR completed for document ${document.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

  } catch (error) {
    console.error(`[OCR] Failed for document ${documentId}:`, error.message);

    try {
      if (document) {
        const logs = Array.isArray(document.activityLogs)
          ? [...document.activityLogs]
          : [];
        logs.push({
          message:   "OCR failed: " + error.message,
          status:    "FAILED",
          timestamp: new Date(),
        });
        await document.update({ uploadStatus: "FAILED", activityLogs: logs });
      }

      // ── Audit: OCR failed ────────────────────────────────────
      await AuditService.log({
        models,
        userId: document?.uploadedBy,
        tenantId: document?.tenantId,
        module: AUDIT_MODULES.OCR,
        action: AUDIT_ACTIONS.OCR_FAILED,
        documentId: document?.id,
        status: AUDIT_STATUS.FAILED,
        remarks: `OCR failed for document ${documentId}: ${error.message}`,
      });
    } catch (updateErr) {
      console.error("[OCR] Could not update failure status:", updateErr.message);
    }
  }
}

module.exports = processOCR;