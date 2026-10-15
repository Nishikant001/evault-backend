// src/services/ocr/labelDictionary.js
// Common invoice labels, used ONLY to know where one field's value must stop.
const MULTI = [
  "invoice number", "invoice no", "invoice date", "invoice amount", "invoice value", "total invoice amount",
  "bill number", "bill no", "bill date", "due date", "payment due", "amount due", "due amount",
  "po number", "po no", "po date", "purchase order number", "purchase order no", "purchase order", "order number", "order no", "order date",
  "delivery date", "challan no", "challan number", "lr number", "lr no",
  "vendor name", "vendor gstin", "vendor code", "supplier name", "supplier gstin", "customer name", "customer gstin", "buyer gstin",
  "gstin number", "gst number", "gst no", "pan number", "pan no",
  "taxable amount", "taxable value", "total amount", "grand total", "sub total", "net amount", "round off",
  "payment terms", "place of supply", "billing location", "bill to", "ship to", "batch no", "batch number", "hsn code",
];
// One-word labels: boundary tabhi maana jayega jab unke baad ":" ya "=" ho
const SINGLE_COLON = ["date", "dated", "gstin", "pan", "total", "amount", "vendor", "supplier", "customer", "terms", "plant", "department", "address", "cgst", "sgst", "igst"];

const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function boundaryFor(ownAliases = []) {
  const own = ownAliases.map(norm).filter(Boolean);
  const clash = (label) => {
    const n = norm(label);
    return own.some((o) => o === n || (o.length >= 4 && (o.includes(n) || n.includes(o))));
  };
  return { labels: MULTI.filter((l) => !clash(l)), colonLabels: SINGLE_COLON.filter((l) => !clash(l)) };
}

module.exports = { boundaryFor, MULTI, SINGLE_COLON };