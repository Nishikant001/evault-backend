// src/services/ocr/extractor.js
// Free-engine document extraction: native PDF text where a meaningful text
// layer exists, Tesseract OCR for scanned/insufficient pages, per-page
// provenance, partial-failure tolerance.
const fs = require("fs");
const path = require("path");
const { extractNativePages } = require("./pdfNative");
const { recognizePages } = require("./tesseractEngine");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif"]);

function summarize(pages, engine) {
  const confs = pages.filter((p) => p.averageConfidence !== null && p.averageConfidence !== undefined).map((p) => p.averageConfidence);
  const failed = pages.filter((p) => p.error).length;
  const extractedText = pages.map((p) => p.text).filter(Boolean).join("\n\n");
  return {
    provider: engine, engine, pageCount: pages.length, pages, extractedText,
    averageConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
    pagesFailed: failed,
    status: failed === 0 ? "COMPLETED" : failed === pages.length ? "FAILED" : "PARTIAL",
    sources: [...new Set(pages.map((p) => p.source))],
  };
}

async function extractWithTesseract(filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error("Source file is not available for OCR.");
  const ext = path.extname(filePath).toLowerCase();
  const started = Date.now();
  let pages;
  const warnings = [];

  if (ext === ".pdf") {
    let native = null;
    try { native = await extractNativePages(filePath); }
    catch (err) { warnings.push(`Native text extraction unavailable: ${err.message}`); }

    if (native && native.length) {
      const needOcr = native.filter((p) => !p.hasNativeText).map((p) => ({ pageNumber: p.pageNumber }));
      const ocrPages = needOcr.length ? await recognizePages(needOcr, { pdfPath: filePath }) : [];
      const ocrByPage = new Map(ocrPages.map((p) => [p.pageNumber, p]));
      pages = native.map((p) => p.hasNativeText
        // A page with a meaningful text layer is NOT also OCR'd => no duplicated text.
        ? { pageNumber: p.pageNumber, text: p.text, words: p.words, averageConfidence: null, source: "native", engine: "pdf-text", width: p.width, height: p.height }
        : ocrByPage.get(p.pageNumber));
    } else {
      // Could not read the PDF structure natively: OCR every page. Page count from pdfinfo-free probe.
      let count = 0;
      try { const { stdout } = await require("util").promisify(require("child_process").execFile)("pdfinfo", [filePath], { timeout: 30000 }); count = Number((stdout.match(/Pages:\s+(\d+)/) || [])[1]) || 0; } catch (_) { /* below */ }
      if (!count) throw new Error("Could not determine PDF page count (is poppler-utils installed and the file a valid PDF?).");
      pages = await recognizePages(Array.from({ length: count }, (_, i) => ({ pageNumber: i + 1 })), { pdfPath: filePath });
    }
  } else if (IMAGE_EXT.has(ext)) {
    pages = await recognizePages([{ pageNumber: 1, imagePath: filePath }]);
  } else {
    throw new Error(`Unsupported file type "${ext || "unknown"}" for OCR. Supported: PDF and ${[...IMAGE_EXT].join(", ")}.`);
  }

  const ocrData = summarize(pages, "tesseract");
  ocrData.warnings = warnings.concat(pages.filter((p) => p.error).map((p) => `Page ${p.pageNumber}: ${p.error}`));
  ocrData.durationMs = Date.now() - started;
  if (ocrData.status === "FAILED") {
    const err = new Error(`OCR failed on all pages. ${ocrData.warnings[0] || ""}`.trim());
    err.ocrData = ocrData; throw err;
  }
  return ocrData;
}

module.exports = { extractWithTesseract, summarize };
