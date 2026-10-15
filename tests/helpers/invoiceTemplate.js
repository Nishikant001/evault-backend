// Test-only template (what a Tenant Admin would configure). Not used by app code.
const f = (id, label, internalName, fieldType, extra = {}) => ({ id, label, internalName, fieldType, displayOrder: id, required: false, ocrAliases: [], ...extra });
module.exports = [
  f(1, "Invoice Number", "invoiceNumber", "TEXT", { required: true, ocrAliases: [{ alias: "Invoice No", status: "ACTIVE" }] }),
  f(2, "Invoice Date", "invoiceDate", "DATE", { required: true }),
  f(3, "Vendor Name", "vendorName", "TEXT", { ocrAliases: [{ alias: "Supplier", status: "ACTIVE" }] }),
  f(4, "Vendor GSTIN", "vendorGstin", "TEXT", { validation: { gstValidation: true } }),
  f(5, "Taxable Amount", "taxableAmount", "CURRENCY", { ocrAliases: [{ alias: "Sub Total", status: "ACTIVE" }] }),
  f(6, "Total Invoice Amount", "totalAmount", "CURRENCY", { required: true, ocrAliases: [{ alias: "Grand Total", status: "ACTIVE" }] }),
  f(7, "Batch No", "batchNo", "TEXT", { ocrAliases: [{ alias: "Batch Number", status: "ACTIVE" }] }),
];
