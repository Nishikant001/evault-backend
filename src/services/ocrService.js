// src/services/ocrService.js
// Tesseract-only OCR engine. Keeps the legacy return fields while also
// returning page/word geometry and OCR confidence for smarter metadata mapping.

const { extractWithTesseract } = require("./ocr/extractor");

class OcrService {
  /**
   * Free-engine entry point (Tesseract + native PDF text). Return shape is
   * unchanged ({ extractedText, fields, ocrData }); ocrData now additionally
   * carries per-page source ("native" | "ocr"), word-level confidence/bbox
   * (previously always empty — see docs), status and warnings.
   * Never logs document text.
   */
  static async process(filePath) {
    const ocrData = await extractWithTesseract(filePath);
    const extractedText = ocrData.extractedText;
    console.log(`[OCR] tesseract status=${ocrData.status} pages=${ocrData.pageCount} sources=${ocrData.sources.join("+")} chars=${extractedText.length} ms=${ocrData.durationMs}`);
    return { extractedText, fields: OcrService.parseFields(extractedText), ocrData };
  }

  static parseFields(text) {
    const get = (patterns) => {
      const normalized = String(text || "")
        .replace(/\r/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n+/g, "\n");
      for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (match && match[1]) return match[1].trim();
      }
      return null;
    };
    const invoiceNumber = get([/Invoice\s*Number\s*:?[ \t]*([A-Z0-9][A-Z0-9\-/]+)/i, /Invoice\s*No\.?\s*:?[ \t]*([A-Z0-9][A-Z0-9\-/]+)/i, /Invoice\s*#\s*:?[ \t]*([A-Z0-9][A-Z0-9\-/]+)/i]);
    const invoiceDate = get([/Invoice\s*Date\s*:?\s*([0-9]{1,4}[./-][0-9]{1,2}[./-][0-9]{1,4})/i, /Date\s*:?\s*([0-9]{1,4}[./-][0-9]{1,2}[./-][0-9]{1,4})/i]);
    const poNumber = get([/PO\s*Number\s*:?\s*([A-Z0-9][A-Z0-9\-/]+)/i, /PO\s*No\.?\s*:?\s*([A-Z0-9][A-Z0-9\-/]+)/i, /Purchase\s*Order\s*No\.?\s*:?\s*([A-Z0-9][A-Z0-9\-/]+)/i]);
    const vendorName = get([/Vendor\s*Name\s*:?\s*([^\n]+)/i, /Supplier\s*:?\s*([^\n]+)/i, /Vendor\s*:?\s*([^\n]+)/i]);
    const plant = get([/Plant\s*:?\s*([A-Z0-9][A-Z0-9\-/]+)/i]);
    const subTotal = get([/Sub\s*Total\s*:?\s*([₹$€£]?[ \t]*[0-9][0-9,.]*)/i]);
    const gstAmount = get([/GST\s*Amount\s*:?\s*([₹$€£]?[ \t]*[0-9][0-9,.]*)/i, /IGST\s*:?\s*([₹$€£]?[ \t]*[0-9][0-9,.]*)/i, /CGST\s*:?\s*([₹$€£]?[ \t]*[0-9][0-9,.]*)/i]);
    const totalAmount = get([/Total\s*Amount\s*:?\s*([₹$€£]?[ \t]*[0-9][0-9,.]*)/i, /Grand\s*Total\s*:?\s*([₹$€£]?[ \t]*[0-9][0-9,.]*)/i]);
    const costCenter = get([/Cost\s*Center\s*:?\s*([A-Z0-9][A-Z0-9\-/]+)/i]);
    const glAccount = get([/GL\s*Account\s*:?\s*([A-Z0-9][A-Z0-9\-/]+)/i]);
    const withConf = (value) => value ? { value, confidence: "High" } : { value: null, confidence: "Low" };
    return {
      invoiceNumber: withConf(invoiceNumber), invoiceDate: withConf(invoiceDate), poNumber: withConf(poNumber),
      vendorName: withConf(vendorName), subTotal: withConf(subTotal), gstAmount: withConf(gstAmount),
      totalAmount: withConf(totalAmount), plant: withConf(plant),
      costCenter: costCenter ? { value: costCenter, confidence: "Mid" } : { value: null, confidence: "Low" },
      glAccount: withConf(glAccount),
    };
  }
}

// Alias matching supports same-line and next-line values. The return shape keeps
// the existing { value, matchedAlias } contract and adds mapping diagnostics.
OcrService.findValueForAliases = function (text, aliases = [], options = {}) {
  if (!text || !Array.isArray(aliases) || !aliases.length) return null;
  const lines = String(text).replace(/\r/g, "").split("\n").map((line) => line.replace(/[\t ]+/g, " ").trim());
  const sortedAliases = [...new Set(aliases.filter((a) => typeof a === "string" && a.trim()))]
    .sort((a, b) => b.length - a.length);
  const candidates = [];
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    for (const alias of sortedAliases) {
      const escaped = escapeRegex(alias.trim());
      // Require a label boundary to avoid matching an alias inside another word.
      const pattern = new RegExp(`(?:^|\\b)${escaped}(?:\\b)?\\s*(?::|=|#|\\-|–|—)?\\s*(.*)$`, "i");
      const match = line.match(pattern);
      if (!match) continue;
      let value = (match[1] || "").trim().replace(/^[|:;=\-–—]+\s*/, "").trim();
      let strategy = "same-line";
      if (!value) {
        for (let next = i + 1; next < lines.length && next <= i + 2; next += 1) {
          if (!lines[next]) continue;
          // Do not consume another label as this field's value.
          const looksLikeLabel = /[:=]$/.test(lines[next]) || /^[A-Za-z][A-Za-z0-9 /#()._-]{1,35}\s*[:=]$/.test(lines[next]);
          if (looksLikeLabel) break;
          value = lines[next].trim();
          strategy = "next-line";
          break;
        }
      }
      if (!value) continue;
      // Avoid returning a whole following label/value line when it is clearly another field.
      value = value.replace(/\s{2,}.+$/, (tail) => tail.includes(":") ? "" : tail).trim();
      if (!value) continue;
      const score = strategy === "same-line" ? 0.9 : 0.78;
      candidates.push({ value, matchedAlias: alias, strategy, score, lineIndex: i });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.matchedAlias.length - a.matchedAlias.length || a.lineIndex - b.lineIndex);
  return candidates[0];
};

OcrService.extractGenericPairs = function (text) {
  if (!text) return [];
  const lines = String(text).replace(/\r/g, "").split("\n");
  const pairs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9 .#/()_-]{1,50}?)\s*[:=]\s*(.*)$/);
    if (match) {
      let value = (match[2] || "").trim();
      if (!value) {
        const next = lines.slice(i + 1).find((candidate) => candidate.trim());
        if (next && !/^[A-Za-z][A-Za-z0-9 .#/()_-]{1,50}\s*[:=]$/.test(next.trim())) value = next.trim();
      }
      if (value) pairs.push({ label: match[1].trim(), value });
    }
  }
  return pairs;
};

module.exports = OcrService;
