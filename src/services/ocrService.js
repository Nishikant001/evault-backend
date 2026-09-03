// src/services/ocrService.js
const Tesseract = require("tesseract.js");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);

// Renders every page of a PDF to a PNG using poppler's `pdftoppm` CLI.
//
// Previously this used pdfjs-dist + node-canvas to rasterize pages. That
// pipeline was found to silently produce BLANK pages on this server: pdf.js
// logs "Requesting object that isn't resolved yet <Font>_path_<char>" for
// every character and never actually draws the glyphs onto the canvas, so
// Tesseract OCR'd an essentially empty page (only table borders/lines
// survive, since those aren't font glyphs) — extractedText came back as
// near-nothing (e.g. "==\n\n") even though the PDF visually has full text.
// `canvas`'s prebuilt native binary is also fragile across environments.
// `pdftoppm` (from the `poppler-utils` OS package) renders text/tables
// correctly and has no Node native-binding to break.
//
// REQUIRES: `poppler-utils` installed on the server —
//   Debian/Ubuntu: apt-get install -y poppler-utils
//   (already ships with most Linux base images; `pdftoppm -v` to check)
async function renderPdfToPngs(filePath) {
  const outPrefix = filePath.replace(/\.pdf$/i, "_ocr_page");
  try {
    await execFileAsync("pdftoppm", ["-png", "-r", "200", filePath, outPrefix]);
  } catch (err) {
    throw new Error(
      `PDF rendering failed — is poppler-utils installed on this server? ` +
      `(apt-get install -y poppler-utils). Details: ${err.message}`
    );
  }

  const dir = path.dirname(outPrefix);
  const base = path.basename(outPrefix);
  // pdftoppm zero-pads the page number to the width of the total page
  // count (e.g. "-1", "-01", "-001"), so a plain lexical sort of matching
  // files always comes out in correct page order.
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base) && f.endsWith(".png"))
    .sort()
    .map((f) => path.join(dir, f));
}

class OcrService {
  static async process(filePath) {
    const ext = path.extname(filePath).toLowerCase();

    let imagePaths = [];
    let tempImageCreated = false;

    if (ext === ".pdf") {
      imagePaths = await renderPdfToPngs(filePath);
      console.log(`PNG pages created: ${imagePaths.length}`);
      tempImageCreated = true;
    } else {
      imagePaths = [filePath];
    }

    let text = "";
    for (const imgPath of imagePaths) {
      const ocrResult = await Tesseract.recognize(imgPath, "eng");
      text += ocrResult.data.text + "\n";
    }

    console.log("============== OCR TEXT ==============");
    console.log(text);
    console.log("======================================");

    // if (tempImageCreated) {
    //   for (const imgPath of imagePaths) {
    //     if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    //   }
    // }

    const fields = OcrService.parseFields(text);
    return { extractedText: text, fields };
  }

  static parseFields(text) {
    const get = (patterns) => {
      const normalized = text
        .replace(/\r/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n+/g, "\n");

      for (const pattern of patterns) {
        const match = normalized.match(pattern);

        if (match && match[1]) {
          return match[1].trim();
        }
      }

      return null;
    };

    const invoiceNumber = get([
      /Invoice\s*Number\s*:?\s*([A-Z0-9\-]+)/i,
      /Invoice\s*No\.?\s*:?\s*([A-Z0-9\-]+)/i,
      /Invoice\s*#\s*:?\s*([A-Z0-9\-]+)/i,
    ]);
    const invoiceDate = get([
      /Invoice\s*Date\s*:?\s*([0-9\-\/]+)/i,
      /Date\s*:?\s*([0-9\-\/]+)/i,
    ]);
    const poNumber = get([
      /PO\s*Number\s*:?\s*([A-Z0-9\-]+)/i,
      /PO\s*No\.?\s*:?\s*([A-Z0-9\-]+)/i,
      /Purchase\s*Order\s*No\.?\s*:?\s*([A-Z0-9\-]+)/i,
    ]);
    const vendorName = get([
      /Vendor\s*Name\s*:?\s*(.+)/i,
      /Supplier\s*:?\s*(.+)/i,
      /Vendor\s*:?\s*(.+)/i,
    ]);
    const plant = get([/Plant\s*:?\s*([A-Z0-9\-]+)/i]);
    const subTotal = get([/Sub\s*Total\s*:?\s*([0-9,.]+)/i]);
    const gstAmount = get([
      /GST\s*Amount\s*:?\s*([0-9,.]+)/i,
      /IGST\s*:?\s*([0-9,.]+)/i,
      /CGST\s*:?\s*([0-9,.]+)/i,
    ]);
    const totalAmount = get([
      /Total\s*Amount\s*:?\s*([0-9,.]+)/i,
      /Grand\s*Total\s*:?\s*([0-9,.]+)/i,
    ]);
    const costCenter = get([/Cost\s*Center\s*:?\s*([A-Z0-9\-]+)/i]);
    const glAccount = get([/GL\s*Account\s*:?\s*([A-Z0-9\-]+)/i]);

    const withConf = (val) =>
      val
        ? { value: val, confidence: "High" }
        : { value: null, confidence: "Low" };

    return {
      invoiceNumber: withConf(invoiceNumber),
      invoiceDate: withConf(invoiceDate),
      poNumber: withConf(poNumber),
      vendorName: withConf(vendorName),
      subTotal: withConf(subTotal),
      gstAmount: withConf(gstAmount),
      totalAmount: withConf(totalAmount),
      plant: withConf(plant),
      costCenter: costCenter
        ? { value: costCenter, confidence: "Mid" }
        : { value: null, confidence: "Low" },
      glAccount: withConf(glAccount),
    };
  }
}

// ── Dynamic Metadata Template Engine support ──────────────────
// Generic, alias-driven value lookup — replaces the need for any
// hardcoded field list. Given raw OCR text and a set of candidate labels
// (the field's own label/internalName plus every configured OCRAlias),
// this tries each label as "label <separator> value" against every line
// of the document and returns the first match, whichever alias hit.
// This is intentionally simple (line-based regex) rather than an NLP
// model, consistent with the rest of this OCR engine.
OcrService.findValueForAliases = function (text, aliases = []) {
  if (!text || !aliases.length) return null;

  const normalized = text.replace(/\r/g, "").replace(/[ \t]+/g, " ");
  const lines = normalized.split("\n");

  // Longer aliases first so "Tax Invoice No" is tried before "Invoice No"
  const sortedAliases = [...aliases]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const alias of sortedAliases) {
    const escaped = alias
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s*");
    // "<alias> : value" / "<alias> - value" / "<alias>value" on the same line
    const pattern = new RegExp(`${escaped}\\s*[:#\\-]?\\s*(.+)`, "i");

    for (const line of lines) {
      const match = line.match(pattern);
      if (match && match[1] && match[1].trim().length) {
        return { value: match[1].trim(), matchedAlias: alias };
      }
    }
  }

  return null;
};

// Splits OCR text into generic {label, value} pairs wherever a line looks
// like "Label : Value" / "Label - Value". Used as a fallback / for
// display purposes (raw OCR JSON) — not required for alias mapping above.
OcrService.extractGenericPairs = function (text) {
  if (!text) return [];
  const lines = text.replace(/\r/g, "").split("\n");
  const pairs = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(
      /^([A-Za-z][A-Za-z0-9 .#/]{1,40}?)\s*[:#\-]\s*(.+)$/,
    );
    if (match) {
      pairs.push({ label: match[1].trim(), value: match[2].trim() });
    }
  }

  return pairs;
};

module.exports = OcrService;
