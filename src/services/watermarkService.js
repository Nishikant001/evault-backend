// src/services/watermarkService.js
//
// Dynamically stamps every FREE-tenant document with a tiled, diagonal
// watermark (visually matches the reference sample: repeated text at
// ~-40° across the whole page, low-opacity gray) reading the company
// name, "Trial Version", and "Powered by <Company Name>".
//
// Called at SERVE time only (view / download / print / thumbnail) from
// documentController — the stored original file on disk/SAP is never
// touched or rewritten. PAID tenants never call into this module.
//
// PDF path uses pdf-lib (draws directly onto the existing PDF pages —
// keeps text selectable/searchable, doesn't rasterize). NOT YET in
// package.json — run `npm install pdf-lib` before deploying this.
// Image path uses `canvas`, already a project dependency (see ocrService.js
// for the existing canvas usage pattern this follows).

const { createCanvas, loadImage } = require("canvas");

const DEFAULT_COMPANY_NAME = "Excelligent";
const WATERMARK_LABEL = "Excelligent";

function buildWatermarkLines(companyName) {
  return [companyName.toUpperCase(), WATERMARK_LABEL];
}

/** Draws the tiled diagonal watermark onto a 2D canvas context that is `width` x `height`. */
function drawTiledWatermark(ctx, width, height, companyName) {
  const lines = buildWatermarkLines(companyName);
  const text = lines.join("   •   ");

  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = "#3a3a3a";
  ctx.font = `bold ${Math.round(width / 22)}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  const diag = Math.sqrt(width * width + height * height);
  ctx.translate(width / 2, height / 2);
  ctx.rotate((-40 * Math.PI) / 180);

  const stepY = height / 6;
  const stepX = width / 1.4;
  for (let y = -diag / 2; y < diag / 2; y += stepY) {
    for (let x = -diag / 2; x < diag / 2; x += stepX) {
      ctx.fillText(text, x, y);
    }
  }
  ctx.restore();

  // Footer strip — "Powered by <Company Name>", always upright/legible.
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = "#555555";
  ctx.font = `${Math.round(width / 45)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(`Powered by ${companyName}`, width / 2, height - Math.round(width / 45));
  ctx.restore();
}

class WatermarkService {
  /**
   * @param {Buffer} imageBuffer
   * @param {string} mimeType e.g. 'image/png' | 'image/jpeg'
   * @returns {Promise<Buffer>} watermarked image buffer (same format)
   */
  static async watermarkImage(imageBuffer, mimeType = "image/png", companyName = DEFAULT_COMPANY_NAME) {
    const image = await loadImage(imageBuffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(image, 0, 0);
    drawTiledWatermark(ctx, image.width, image.height, companyName);

    const format = mimeType === "image/jpeg" || mimeType === "image/jpg" ? "image/jpeg" : "image/png";
    return canvas.toBuffer(format);
  }

  /**
   * @param {Buffer} pdfBuffer
   * @returns {Promise<Buffer>} watermarked PDF buffer
   */
  static async watermarkPdf(pdfBuffer, companyName = DEFAULT_COMPANY_NAME) {
    let PDFLib;
    try {
      PDFLib = require("pdf-lib");
    } catch {
      throw new Error(
        "pdf-lib not installed. Run: npm install pdf-lib (required for FREE-tenant PDF watermarking).",
      );
    }
    const { PDFDocument, degrees, rgb, StandardFonts } = PDFLib;

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const footerFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const lines = buildWatermarkLines(companyName);
    const tileText = lines.join("   •   ");

    for (const page of pdfDoc.getPages()) {
      const { width, height } = page.getSize();
      const fontSize = width / 22;
      const textWidth = font.widthOfTextAtSize(tileText, fontSize);

      const stepX = textWidth * 1.15;
      const stepY = height / 6;
      const diag = Math.sqrt(width * width + height * height);

      for (let y = -diag / 2; y < diag + height / 2; y += stepY) {
        for (let x = -diag / 2; x < diag + width / 2; x += stepX) {
          page.drawText(tileText, {
            x,
            y,
            size: fontSize,
            font,
            color: rgb(0.23, 0.23, 0.23),
            opacity: 0.14,
            rotate: degrees(-40),
          });
        }
      }

      page.drawText(`Powered by ${companyName}`, {
        x: width / 2 - footerFont.widthOfTextAtSize(`Powered by ${companyName}`, 10) / 2,
        y: 16,
        size: 10,
        font: footerFont,
        color: rgb(0.33, 0.33, 0.33),
        opacity: 0.55,
      });
    }

    const bytes = await pdfDoc.save();
    return Buffer.from(bytes);
  }

  /** Dispatches by mimeType. Falls through unchanged for types we don't watermark (e.g. .docx originals). */
  static async watermark(buffer, mimeType, companyName = DEFAULT_COMPANY_NAME) {
    if (mimeType === "application/pdf") return this.watermarkPdf(buffer, companyName);
    if (mimeType && mimeType.startsWith("image/")) return this.watermarkImage(buffer, mimeType, companyName);
    return buffer; // unsupported type for dynamic watermarking — served as-is
  }
}

module.exports = WatermarkService;
