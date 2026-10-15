const test = require("node:test");
const assert = require("node:assert/strict");
const fx = require("./helpers/fixtures");
const template = require("./helpers/invoiceTemplate");
const { mapFields } = require("../src/services/ocr/fieldMapper");
const { findSpatialValueForAliases } = require("../src/services/dynamicOcrMappingService");
const { extractWithTesseract } = require("../src/services/ocr/extractor");

const run = (fields, text, ocrData) => mapFields({ fields, extractedText: text, ocrData, spatialFinder: findSpatialValueForAliases });
const TEXT = fx.INVOICE_LINES.join("\n");

test("returns an entry for EVERY configured field, in template order, and nothing else", () => {
  const { mapped, confidence } = run(template, TEXT);
  assert.deepEqual(Object.keys(confidence), template.map((t) => t.internalName));
  assert.deepEqual(Object.keys(mapped), template.map((t) => t.internalName));
});

test("single-field template maps only that field (extra OCR text is ignored)", () => {
  const { mapped } = run([template[0]], TEXT);
  assert.deepEqual(Object.keys(mapped), ["invoiceNumber"]);
  assert.equal(mapped.invoiceNumber, "PH-INV-2026-0918-0147");
});

test("taxable amount and total invoice amount are never confused", () => {
  const { mapped } = run(template, TEXT);
  assert.equal(mapped.taxableAmount, "25000.00"); assert.equal(mapped.totalAmount, "29500.00");
});

test("a generic 'Amount' alias does not capture 'Taxable Amount' / 'Total Invoice Amount'", () => {
  const fields = [{ id: 1, label: "Amount", internalName: "amount", fieldType: "CURRENCY", displayOrder: 1, ocrAliases: [] }, template[4], template[5]];
  const { mapped, confidence } = run(fields, TEXT);
  assert.equal(mapped.taxableAmount, "25000.00"); assert.equal(mapped.totalAmount, "29500.00");
  assert.equal(mapped.amount, null); assert.equal(confidence.amount.status, "NOT_DETECTED");
});

test("tenant-specific alias and differing label are honoured", () => {
  const fields = [{ id: 1, label: "Bill Ref", internalName: "billRef", fieldType: "TEXT", displayOrder: 1, ocrAliases: [{ alias: "Invoice Number", status: "ACTIVE" }] }];
  assert.equal(run(fields, TEXT).mapped.billRef, "PH-INV-2026-0918-0147");
  assert.equal(run([{ ...fields[0], ocrAliases: [{ alias: "Invoice Number", status: "INACTIVE" }] }], TEXT).mapped.billRef, null);
});

test("missing configured field stays present, empty, and is flagged NOT_DETECTED (never invented)", () => {
  const fields = [...template, { id: 9, label: "PO Number", internalName: "poNumber", fieldType: "TEXT", displayOrder: 9, required: true, ocrAliases: [] }];
  const { mapped, confidence } = run(fields, TEXT);
  assert.equal(mapped.poNumber, null); assert.equal(confidence.poNumber.status, "NOT_DETECTED"); assert.equal(confidence.poNumber.score, 0);
});

test("incorrectly formatted date/amount are kept as-is, marked INVALID_FORMAT and LOW", () => {
  const { mapped, confidence } = run(template, "Invoice Date: 32-13-2026\nTotal Invoice Amount: 29,5OO.00");
  assert.equal(mapped.invoiceDate, "32-13-2026"); assert.equal(confidence.invoiceDate.status, "INVALID_FORMAT"); assert.equal(confidence.invoiceDate.confidence, "Low");
  assert.equal(confidence.totalAmount.status, "INVALID_FORMAT"); // O not silently converted to 0
  assert.match(mapped.totalAmount, /5OO/);
});

test("multiple candidate values are preserved and flagged AMBIGUOUS (not silently picked as certain)", () => {
  const { confidence } = run([template[0]], "Invoice Number: INV-1111\nInvoice Number: INV-2222");
  assert.equal(confidence.invoiceNumber.status, "AMBIGUOUS");
  assert.deepEqual(confidence.invoiceNumber.candidates.map((c) => c.value).sort(), ["INV-1111", "INV-2222"]);
  assert.notEqual(confidence.invoiceNumber.confidence, "High");
});

test("repeating labels on one line yield all batch numbers as candidates (no repeating-group model exists)", () => {
  const { confidence } = run([template[6]], TEXT);
  const vals = confidence.batchNo.candidates.map((c) => c.value).sort();
  assert.deepEqual(vals, ["AMX500-26C21", "AZ500-26A17", "ORS-26D11", "P40-26B09"]);
  assert.equal(confidence.batchNo.status, "AMBIGUOUS");
});

test("neighbouring label swallowed into a value is stripped using other configured labels", () => {
  const { mapped } = run(template, "Invoice Number: PH-INV-1 Invoice Date: 18-09-2026");
  assert.equal(mapped.invoiceNumber, "PH-INV-1"); assert.equal(mapped.invoiceDate, "2026-09-18");
});

test("validation failure and valid-format do not inflate confidence; GSTIN checksum mismatch -> needs review", () => {
  const { confidence } = run(template, TEXT);
  assert.equal(confidence.vendorGstin.validationPassed, true);
  assert.equal(confidence.vendorGstin.status, "NEEDS_REVIEW");
  assert.ok(confidence.vendorGstin.score <= 0.7 && confidence.vendorGstin.scoreType === "heuristic");
});

test("ACCEPTANCE (real OCR of synthetic scan): field-by-field", async () => {
  const ocr = await extractWithTesseract(await fx.scannedPdf());
  const { mapped, confidence } = run(template, ocr.extractedText, ocr);
  const expected = { invoiceNumber: "PH-INV-2026-0918-0147", invoiceDate: "2026-09-18", vendorName: "Sunrise Pharma Distributors Pvt. Ltd.", vendorGstin: "21AABCS4821H1Z8", taxableAmount: "25000.00", totalAmount: "29500.00" };
  const report = {};
  for (const [k, v] of Object.entries(expected)) report[k] = { expected: v, got: mapped[k], status: confidence[k].status, conf: confidence[k].confidence, ocrConf: confidence[k].ocrConfidence };
  console.log("ACCEPTANCE_REPORT " + JSON.stringify(report));
  for (const [k, v] of Object.entries(expected)) assert.equal(mapped[k], v, `${k}`);
  const batches = confidence.batchNo.candidates.map((c) => c.value).sort();
  assert.deepEqual(batches, ["AMX500-26C21", "AZ500-26A17", "ORS-26D11", "P40-26B09"]);
  assert.ok(confidence.invoiceNumber.ocrConfidence > 0.5 && confidence.invoiceNumber.page === 1);
});
