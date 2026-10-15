// Test-only synthetic invoice fixtures. NEVER required from application code.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCanvas } = require("canvas");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const INVOICE_LINES = [
  "TAX INVOICE",
  "Invoice Number: PH-INV-2026-0918-0147",
  "Invoice Date: 18-09-2026",
  "Vendor Name: Sunrise Pharma Distributors Pvt. Ltd.",
  "Vendor GSTIN: 21AABCS4821H1Z8",
  "Batch No: AZ500-26A17   Batch No: P40-26B09",
  "Batch No: AMX500-26C21   Batch No: ORS-26D11",
  "Taxable Amount: 25,000.00",
  "Total Invoice Amount: 29,500.00",
];

function tmp(name) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ocrfx-")), name); }

function renderInvoicePng({ lines = INVOICE_LINES, skewDeg = 0, noise = 0, width = 1700, height = 900, fontPx = 40 } = {}) {
  const canvas = createCanvas(width, height); const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
  ctx.save(); ctx.translate(width / 2, height / 2); ctx.rotate((skewDeg * Math.PI) / 180); ctx.translate(-width / 2, -height / 2);
  ctx.fillStyle = "#111"; ctx.font = `${fontPx}px sans-serif`;
  lines.forEach((l, i) => ctx.fillText(l, 60, 80 + i * (fontPx + 28)));
  ctx.restore();
  if (noise) {
    const img = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * noise; img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, img.data[i] + n)); }
    ctx.putImageData(img, 0, 0);
  }
  return canvas.toBuffer("image/png");
}

function writePng(opts, name = "invoice.png") { const p = tmp(name); fs.writeFileSync(p, renderInvoicePng(opts)); return p; }

async function digitalPdf(pagesOfLines = [INVOICE_LINES]) {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pagesOfLines) { const page = doc.addPage([595, 842]); lines.forEach((l, i) => page.drawText(l, { x: 40, y: 780 - i * 26, size: 12, font, color: rgb(0, 0, 0) })); }
  const p = tmp("digital.pdf"); fs.writeFileSync(p, await doc.save()); return p;
}

// image-only PDF (a scan): each page is an embedded PNG, no text layer
async function scannedPdf(pngOptsPerPage = [{}]) {
  const doc = await PDFDocument.create();
  for (const o of pngOptsPerPage) { const img = await doc.embedPng(renderInvoicePng(o)); const page = doc.addPage([595, 842]); page.drawImage(img, { x: 0, y: 842 - 595 * (img.height / img.width), width: 595, height: 595 * (img.height / img.width) }); }
  const p = tmp("scanned.pdf"); fs.writeFileSync(p, await doc.save()); return p;
}

// page 1 digital text, page 2 scanned image
async function mixedPdf() {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]); INVOICE_LINES.forEach((l, i) => p1.drawText(l, { x: 40, y: 780 - i * 26, size: 12, font }));
  const img = await doc.embedPng(renderInvoicePng({ lines: ["Delivery Note", "Remarks: Handle with care", "Carrier Reference: CR-778812"] }));
  const p2 = doc.addPage([595, 842]); p2.drawImage(img, { x: 0, y: 842 - 595 * (img.height / img.width), width: 595, height: 595 * (img.height / img.width) });
  const p = tmp("mixed.pdf"); fs.writeFileSync(p, await doc.save()); return p;
}

module.exports = { INVOICE_LINES, renderInvoicePng, writePng, digitalPdf, scannedPdf, mixedPdf, tmp };
