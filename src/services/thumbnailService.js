// src/services/thumbnailService.js
//
// Generates a small preview image (PNG) from a document buffer, for the
// new GET /:id/thumbnail endpoint. Mirrors the existing pdfjs+canvas
// rasterization pattern already used in ocrService.js (first page only —
// a thumbnail doesn't need the whole document). Image inputs are simply
// downscaled with `canvas`, already a project dependency.
//
// This module does NOT watermark — documentController calls
// watermarkService afterward for FREE tenants, same as /view and
// /download, so the tiled watermark is applied consistently across every
// binary-serving surface.

const { createCanvas, loadImage } = require("canvas");

const DEFAULT_MAX_WIDTH = 320;

class ThumbnailService {
  static async fromImage(buffer, maxWidth = DEFAULT_MAX_WIDTH) {
    const image = await loadImage(buffer);
    const scale = Math.min(1, maxWidth / image.width);
    const width = Math.round(image.width * scale);
    const height = Math.round(image.height * scale);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, width, height);
    return canvas.toBuffer("image/png");
  }

  static async fromPdf(buffer, maxWidth = DEFAULT_MAX_WIDTH) {
    let pdfjsLib;
    try {
      pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
    } catch {
      try {
        pdfjsLib = require("pdfjs-dist");
      } catch {
        throw new Error("pdfjs-dist not installed. Run: npm install pdfjs-dist canvas");
      }
    }

    const loadTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdf = await loadTask.promise;
    const page = await pdf.getPage(1);

    const baseViewport = page.getViewport({ scale: 1 });
    const scale = maxWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;

    return canvas.toBuffer("image/png");
  }

  static async generate(buffer, mimeType, maxWidth = DEFAULT_MAX_WIDTH) {
    if (mimeType === "application/pdf") return this.fromPdf(buffer, maxWidth);
    if (mimeType && mimeType.startsWith("image/")) return this.fromImage(buffer, maxWidth);
    throw new Error(`Thumbnails are not supported for mimeType "${mimeType}"`);
  }
}

module.exports = ThumbnailService;
