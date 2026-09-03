const SapService = require("./sapService");

class DocumentService {

  // ===============================
  // IN-MEMORY STORE (replace with DB later)
  // ===============================
  static documents = [];

  // ===============================
  // CREATE DOCUMENT (INIT FLOW)
  // ===============================
  static async createDocument(input) {
    const document = {
      id: `DOC_${Date.now()}`,
      tenantId: input.tenantId || "DEFAULT",
      fileName: input.fileName,
      fileUrl: input.fileUrl || null,

      metadata: {
        vendor: input.vendor || null,
        amount: input.amount || null,
        currency: input.currency || "INR",
        poNumber: input.poNumber || null,
      },

      ocrData: null,

      status: "DRAFT",

      workflow: {
        currentLevel: "L0",
        history: [
          {
            action: "CREATED",
            by: input.userId || "SYSTEM",
            at: new Date(),
          },
        ],
      },

      sap: {
        sapDocumentId: null,
        posted: false,
      },

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.documents.push(document);

    return document;
  }

  // ===============================
  // GET ALL DOCUMENTS
  // ===============================
  static async getAllDocuments() {
    return this.documents;
  }

  // ===============================
  // GET BY ID
  // ===============================
  static async getDocumentById(id) {
    const doc = this.documents.find(d => d.id === id);

    if (!doc) throw new Error("Document not found");

    return doc;
  }

  // ===============================
  // OCR UPDATE
  // ===============================
  static async updateOCR(id, ocrData) {
    const doc = await this.getDocumentById(id);

    doc.ocrData = ocrData;
    doc.status = "OCR_COMPLETED";
    doc.updatedAt = new Date();

    doc.workflow.history.push({
      action: "OCR_COMPLETED",
      at: new Date(),
    });

    return doc;
  }

  // ===============================
  // SUBMIT FOR APPROVAL
  // ===============================
  static async submitForApproval(id) {
    const doc = await this.getDocumentById(id);

    doc.status = "PENDING_APPROVAL";

    doc.workflow.currentLevel = "L1";

    doc.workflow.history.push({
      action: "SUBMITTED_FOR_APPROVAL",
      at: new Date(),
    });

    return doc;
  }

  // ===============================
  // APPROVAL ACTION
  // ===============================
  static async approveDocument(id, level, userId) {
    const doc = await this.getDocumentById(id);

    doc.workflow.history.push({
      action: `APPROVED_${level}`,
      by: userId,
      at: new Date(),
    });

    if (level === "L3") {
      doc.status = "APPROVED";
      doc.workflow.currentLevel = "SAP_POSTING";
    } else {
      doc.workflow.currentLevel = this.nextLevel(level);
    }

    doc.updatedAt = new Date();

    return doc;
  }

  static nextLevel(level) {
    const map = {
      L1: "L2",
      L2: "L3",
    };
    return map[level] || "L3";
  }

  // ===============================
  // REJECT DOCUMENT
  // ===============================
  static async rejectDocument(id, reason, userId) {
    const doc = await this.getDocumentById(id);

    doc.status = "REJECTED";

    doc.workflow.history.push({
      action: "REJECTED",
      reason,
      by: userId,
      at: new Date(),
    });

    return doc;
  }

  // ===============================
  // SAP POSTING (FINAL STEP)
  // ===============================
  static async postToSAP(id) {
    const doc = await this.getDocumentById(id);

    if (doc.status !== "APPROVED") {
      throw new Error("Only approved documents can be posted to SAP");
    }

    const payload = {
      DocumentId: doc.id,
      FileName: doc.fileName,
      Vendor: doc.metadata.vendor,
      Amount: doc.metadata.amount,
      Currency: doc.metadata.currency,
      PO: doc.metadata.poNumber,
      OCR: doc.ocrData,
    };

    const sapResponse = await SapService.createDocument(payload);

    doc.sap.sapDocumentId = sapResponse?.d?.DocumentId || null;
    doc.sap.posted = true;
    doc.status = "POSTED_TO_SAP";

    doc.workflow.history.push({
      action: "POSTED_TO_SAP",
      sapDocumentId: doc.sap.sapDocumentId,
      at: new Date(),
    });

    return doc;
  }

  // ===============================
  // SEARCH / FILTER
  // ===============================
  static async search(query) {
    return this.documents.filter(doc => {
      return (
        doc.id.includes(query) ||
        doc.fileName?.includes(query) ||
        doc.metadata.poNumber?.includes(query)
      );
    });
  }
}

module.exports = DocumentService;