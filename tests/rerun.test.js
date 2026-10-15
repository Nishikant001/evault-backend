const test = require("node:test");
const assert = require("node:assert/strict");
const template = require("./helpers/invoiceTemplate");
const { makeModels } = require("./helpers/fakeModels");
const metadataTemplateService = require("../src/services/metadataTemplateService");
const { mapDocument } = require("../src/services/dynamicOcrMappingService");

const TEXT = "Invoice Number: PH-1\nInvoice Date: 18-09-2026\nTotal Invoice Amount: 100.00";
function setup(t, versions) {
  const models = makeModels();
  models.MetadataTemplateVersion = { findOne: async ({ where }) => versions[where.id] || null };
  t.mock.method(metadataTemplateService, "resolveActiveVersionForDocumentType", async () => versions.active);
  return models;
}
const v1 = { id: 1, fields: template }, v2 = { id: 2, fields: template.slice(0, 2) };

test("first mapping binds the active template version; rerun keeps that version even if a newer one is active", async (t) => {
  const models = setup(t, { 1: v1, 2: v2, active: v1 });
  const r1 = await mapDocument({ documentId: 1, tenantId: 1, documentTypeId: 1, extractedText: TEXT, ocrData: null, models });
  assert.equal(r1.metadataTemplateVersionId, 1);
  metadataTemplateService.resolveActiveVersionForDocumentType.mock.mockImplementation(async () => v2);
  const r2 = await mapDocument({ documentId: 1, tenantId: 1, documentTypeId: 1, extractedText: TEXT, ocrData: null, models });
  assert.equal(r2.metadataTemplateVersionId, 1); // not silently switched
  assert.equal(Object.keys(r2.mappedMetadataJson).length, template.length);
});

test("reprocess does NOT overwrite manual corrections or reset correctionHistory", async (t) => {
  const models = setup(t, { 1: v1, active: v1 });
  const rec = await mapDocument({ documentId: 1, tenantId: 1, documentTypeId: 1, extractedText: TEXT, ocrData: null, models });
  await rec.update({ mappedMetadataJson: { ...rec.mappedMetadataJson, invoiceNumber: "USER-FIXED" }, correctionHistory: [{ internalName: "invoiceNumber", oldValue: "PH-1", newValue: "USER-FIXED", correctedBy: 9 }] });
  const again = await mapDocument({ documentId: 1, tenantId: 1, documentTypeId: 1, extractedText: "Invoice Number: DIFFERENT-9\nInvoice Date: 01-01-2026", ocrData: null, models });
  assert.equal(again.mappedMetadataJson.invoiceNumber, "USER-FIXED");
  assert.equal(again.mappedMetadataJson.invoiceDate, "2026-01-01"); // untouched fields ARE re-mapped
  assert.equal(again.correctionHistory.length, 1);
  assert.equal(again.confidenceJson.invoiceNumber.manuallyEdited, true);
});

test("CONFIRMED metadata is never changed by a re-run; raw OCR snapshot is refreshed", async (t) => {
  const models = setup(t, { 1: v1, active: v1 });
  const rec = await mapDocument({ documentId: 1, tenantId: 1, documentTypeId: 1, extractedText: TEXT, ocrData: null, models });
  await rec.update({ status: "CONFIRMED" });
  const before = JSON.stringify(rec.mappedMetadataJson);
  const again = await mapDocument({ documentId: 1, tenantId: 1, documentTypeId: 1, extractedText: "Invoice Number: ZZZ", ocrData: null, models });
  assert.equal(JSON.stringify(again.mappedMetadataJson), before); assert.equal(again.status, "CONFIRMED");
  assert.match(again.rawOcrJson.extractedText, /ZZZ/);
});

test("stale-result detection data: text hash + template version + engine stored with every mapping", async (t) => {
  const models = setup(t, { 1: v1, active: v1 });
  const rec = await mapDocument({ documentId: 1, tenantId: 1, documentTypeId: 1, extractedText: TEXT, ocrData: { provider: "tesseract", pages: [] }, ocrRun: { engineUsed: "tesseract", engineRequested: "TESSERACT", fallbackUsed: false }, models });
  const s = rec.rawOcrJson.ocrSummary; assert.equal(s.templateVersionId, 1); assert.match(s.textHash, /^[a-f0-9]{64}$/); assert.equal(s.engineUsed, "tesseract");
});

test("no template assigned => nothing created", async (t) => {
  const models = setup(t, { active: null });
  assert.equal(await mapDocument({ documentId: 3, tenantId: 1, documentTypeId: 1, extractedText: TEXT, ocrData: null, models }), null);
});
