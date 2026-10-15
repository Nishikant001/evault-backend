const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fx = require("./helpers/fixtures");
const { extractWithTesseract } = require("../src/services/ocr/extractor");

const ocrTmpDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("evault-ocr-"));
test.before(() => { process.env.OCR_MAX_PREPROCESS_VARIANTS = "3"; });

test("digital-text PDF uses native text, no OCR, with word boxes", async () => {
  const r = await extractWithTesseract(await fx.digitalPdf());
  assert.equal(r.status, "COMPLETED"); assert.deepEqual(r.sources, ["native"]);
  assert.match(r.extractedText, /PH-INV-2026-0918-0147/);
  assert.ok(r.pages[0].words.length > 20 && r.pages[0].words[0].bbox.x1 > r.pages[0].words[0].bbox.x0);
  assert.equal(r.pages[0].averageConfidence, null); // native text has NO OCR confidence; we do not invent one
});

test("scanned (image-only) PDF is OCR'd with measured word confidence + coordinates", async () => {
  const r = await extractWithTesseract(await fx.scannedPdf());
  assert.deepEqual(r.sources, ["ocr"]);
  assert.match(r.extractedText, /PH-INV-2026-0918-0147/);
  const w = r.pages[0].words.find((x) => /Invoice/.test(x.text));
  assert.ok(w && w.confidence > 50 && w.bbox.x0 >= 0 && w.page === 1);
});

test("mixed PDF: page 1 native, page 2 OCR, no duplicated text", async () => {
  const r = await extractWithTesseract(await fx.mixedPdf());
  assert.deepEqual(r.pages.map((p) => p.source), ["native", "ocr"]);
  assert.match(r.pages[1].text, /Carrier Reference/);
  assert.equal((r.extractedText.match(/PH-INV-2026-0918-0147/g) || []).length, 1);
});

test("multi-page digital PDF keeps page boundaries", async () => {
  const r = await extractWithTesseract(await fx.digitalPdf([fx.INVOICE_LINES, ["Second page content line one", "Second page content line two", "Reference: ABC-12345 and some more filler words here to exceed the minimum"]]));
  assert.equal(r.pageCount, 2); assert.match(r.pages[1].text, /Second page/); assert.equal(r.pages[1].pageNumber, 2);
});

test("skewed + noisy low-quality image: skew detected/corrected and key values recovered", async () => {
  const r = await extractWithTesseract(fx.writePng({ skewDeg: 2.5, noise: 60 }));
  assert.match(r.extractedText, /PH-INV-2026-0918-0147/);
  assert.match(r.extractedText, /29,500\.00/);
  const d = r.pages[0].diagnostics; assert.ok(Math.abs(d.skew.angle - 2.5) <= 1, `skew ${d.skew.angle}`);
});

test("unsupported and missing files fail with actionable errors", async () => {
  const txt = fx.tmp("x.txt"); fs.writeFileSync(txt, "hello");
  await assert.rejects(() => extractWithTesseract(txt), /Unsupported file type/);
  await assert.rejects(() => extractWithTesseract("/nonexistent/file.pdf"), /not available/);
});

test("corrupt PDF fails clearly (no hang, no leaked temp dirs)", async () => {
  const bad = fx.tmp("bad.pdf"); fs.writeFileSync(bad, "%PDF-1.4 not really a pdf");
  const before = ocrTmpDirs().length;
  await assert.rejects(() => extractWithTesseract(bad));
  assert.equal(ocrTmpDirs().length, before);
});

test("temp directories are removed after a successful OCR job", async () => {
  const before = ocrTmpDirs().length;
  await extractWithTesseract(await fx.scannedPdf());
  assert.equal(ocrTmpDirs().length, before);
});

test("per-page timeout: failed page is reported, job does not hang, temp cleaned", async () => {
  const prev = process.env.OCR_PAGE_TIMEOUT_MS; process.env.OCR_PAGE_TIMEOUT_MS = "1";
  const before = ocrTmpDirs().length;
  try {
    await assert.rejects(() => extractWithTesseract(fx.writePng()), /failed on all pages|timed out/);
  } finally { process.env.OCR_PAGE_TIMEOUT_MS = prev || ""; if (!prev) delete process.env.OCR_PAGE_TIMEOUT_MS; }
  assert.equal(ocrTmpDirs().length, before);
});

test("missing language data gives an actionable error", async () => {
  const prev = process.env.OCR_LANGUAGES; process.env.OCR_LANGUAGES = "xyz";
  try { await assert.rejects(() => extractWithTesseract(fx.writePng()), /language data|failed on all pages/i); }
  finally { if (prev) process.env.OCR_LANGUAGES = prev; else delete process.env.OCR_LANGUAGES; }
});
