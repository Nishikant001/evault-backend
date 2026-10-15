// src/services/ocr/pdfNative.js
// Native (digital) PDF text via poppler `pdftotext -bbox`, which returns every
// word with page-relative coordinates in PDF points. Poppler is already a
// documented dependency (pdftoppm is used for rasterisation).
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const MIN_NATIVE_ALNUM_CHARS = Number(process.env.OCR_NATIVE_MIN_CHARS || 40);
const MIN_NATIVE_WORDS = Number(process.env.OCR_NATIVE_MIN_WORDS || 8);

function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
}

function parseBboxHtml(html) {
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  let pm; let n = 0;
  while ((pm = pageRe.exec(html))) {
    n += 1;
    const words = [];
    const wordRe = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g;
    let wm;
    while ((wm = wordRe.exec(pm[3]))) {
      const text = decodeEntities(wm[5]).trim();
      if (!text) continue;
      words.push({ text, confidence: null, page: n, source: "native",
        bbox: { x0: Number(wm[1]), y0: Number(wm[2]), x1: Number(wm[3]), y1: Number(wm[4]) } });
    }
    pages.push({ pageNumber: n, width: Number(pm[1]), height: Number(pm[2]), words });
  }
  return pages;
}

function wordsToText(words) {
  // group by line using vertical proximity, then left-to-right (reading order)
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const lines = [];
  for (const w of sorted) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2, h = Math.max(1, w.bbox.y1 - w.bbox.y0);
    const line = lines.find((l) => Math.abs(l.cy - cy) <= h * 0.6);
    if (line) { line.words.push(w); line.cy = (line.cy * (line.words.length - 1) + cy) / line.words.length; }
    else lines.push({ cy, words: [w] });
  }
   return lines.sort((a, b) => a.cy - b.cy)
    .map((l) => {
      const ws = l.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      // Bada horizontal gap = column break. 3 spaces rakhte hain taaki side-by-side
      // blocks (address box | "Credit Note No." box) ek sentence me na mil jayein.
      return ws.map((w, i) => {
        if (i === 0) return w.text;
        const gap = w.bbox.x0 - ws[i - 1].bbox.x1; const h = Math.max(1, w.bbox.y1 - w.bbox.y0);
        return (gap >= Math.max(10, 1.1 * h) ? "   " : " ") + w.text;
      }).join("");
    }).join("\n");
}

function isMeaningful(words) {
  const joined = words.map((w) => w.text).join("");
  const alnum = (joined.match(/[A-Za-z0-9]/g) || []).length;
  return alnum >= MIN_NATIVE_ALNUM_CHARS && words.length >= MIN_NATIVE_WORDS;
}

/** Returns [{pageNumber,width,height,words,text,hasNativeText}] or throws an actionable error. */
async function extractNativePages(pdfPath, { timeoutMs = 60000 } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("pdftotext", ["-bbox", pdfPath, "-"], { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }));
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("pdftotext not found — install poppler-utils (apt-get install -y poppler-utils).");
    throw new Error(`Native PDF text extraction failed: ${String(err.stderr || err.message).slice(0, 200)}`);
  }
  return parseBboxHtml(stdout).map((p) => ({ ...p, text: wordsToText(p.words), hasNativeText: isMeaningful(p.words) }));
}

module.exports = { extractNativePages, parseBboxHtml, wordsToText, isMeaningful };
