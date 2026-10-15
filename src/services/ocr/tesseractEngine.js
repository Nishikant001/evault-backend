// src/services/ocr/tesseractEngine.js
// Free OCR engine: tesseract.js with managed worker lifecycle, per-page
// timeouts, bounded job concurrency, and quality-based preprocessing choice.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { createWorker } = require("tesseract.js");
const { buildVariants } = require("./preprocess");

const cfg = () => ({
  lang: process.env.OCR_LANGUAGES || "eng",
  langPath: process.env.OCR_LANG_PATH || (fs.existsSync(path.join(__dirname, "../../../eng.traineddata")) ? path.join(__dirname, "../../../") : undefined),
  dpi: Number(process.env.OCR_PDF_DPI || 300),
  pageTimeoutMs: Number(process.env.OCR_PAGE_TIMEOUT_MS || 120000),
  maxPages: Number(process.env.OCR_MAX_PAGES || 50),
  maxConcurrentJobs: Math.max(1, Number(process.env.OCR_MAX_CONCURRENT_JOBS || 2)),
  goodConfidence: Number(process.env.OCR_GOOD_CONFIDENCE || 85),
  maxVariants: Math.max(1, Math.min(3, Number(process.env.OCR_MAX_PREPROCESS_VARIANTS || 3))),
});

// ── bounded concurrency across jobs (process-wide) ─────────────
let active = 0; const waiters = [];
async function acquire(limit) {
  if (active < limit) { active += 1; return; }
  await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}
function release() { active -= 1; const next = waiters.shift(); if (next) next(); }

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { if (onTimeout) onTimeout(); reject(Object.assign(new Error(`OCR timed out after ${ms} ms`), { code: "OCR_TIMEOUT" })); }, ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function newWorker(c) {
  // tesseract.js raises an UNCAUGHT exception (process-level) if a local language
  // file is missing, which would crash the server — so verify before creating a worker.
  if (c.langPath) {
    for (const l of String(c.lang).split("+")) {
      if (!/^[A-Za-z_]{2,20}$/.test(l)) throw new Error(`Invalid OCR language code "${l}" in OCR_LANGUAGES.`);
      if (!fs.existsSync(path.join(c.langPath, `${l}.traineddata`))) {
        throw new Error(`Tesseract language data for "${l}" not found: expected ${l}.traineddata in OCR_LANG_PATH (${c.langPath}). Install it or change OCR_LANGUAGES.`);
      }
    }
  }
  const opts = { cacheMethod: "none", logger: () => {} };
  if (c.langPath) { opts.langPath = c.langPath; opts.gzip = false; }
  try {
    const worker = await createWorker(c.lang, 1 /* LSTM */, opts);
    await worker.setParameters({ preserve_interword_spaces: "1", user_defined_dpi: String(c.dpi) });
    return worker;
  } catch (err) {
    const msg = String(err && err.message || err);
    if (/traineddata|language|Failed to load|fetch|ENOTFOUND|ECONN/i.test(msg)) {
      throw new Error(`Tesseract language data for "${c.lang}" could not be loaded. Place <lang>.traineddata in OCR_LANG_PATH (uncompressed) or allow network access to the tessdata CDN. Details: ${msg.slice(0, 160)}`);
    }
    throw err;
  }
}

function flattenWords(data, pageNumber) {
  const words = []; let lineNo = 0;
  for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
    lineNo += 1;
    for (const w of line.words || []) {
      const text = String(w.text || "").trim(); if (!text) continue;
      const bb = w.bbox || {}; const conf = Number(w.confidence);
      words.push({ text, confidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, conf)) : null, page: pageNumber, line: lineNo, source: "tesseract",
        bbox: { x0: bb.x0 ?? null, y0: bb.y0 ?? null, x1: bb.x1 ?? null, y1: bb.y1 ?? null } });
    }
  }
  return words;
}
const meanConf = (words) => { const v = words.filter((w) => w.confidence !== null).map((w) => w.confidence); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// PSM 3 (auto) is best for mixed documents; 6 (uniform block) helps dense
// invoices/forms. Both are tried only when the first result is weak.
async function recognizeWithRetry(state, c, image, psm) {
  const run = async () => {
    await state.worker.setParameters({ tessedit_pageseg_mode: String(psm) });
    const res = await state.worker.recognize(image, {}, { blocks: true, text: true });
    return res.data;
  };
  try {
    return await withTimeout(run(), c.pageTimeoutMs, () => { const w = state.worker; state.worker = null; w.terminate().catch(() => {}); });
  } finally {
    if (!state.worker) state.worker = await newWorker(c); // replace a worker killed by timeout
  }
}

async function ocrImage(state, c, imagePath, pageNumber) {
  let variants = [];
  try { variants = await buildVariants(imagePath, { maxVariants: c.maxVariants }); } catch (_) { variants = []; }
  const candidates = variants.length ? variants.map((v) => ({ name: v.name, image: v.buffer, meta: v.meta })) : [{ name: "raw", image: imagePath, meta: {} }];
  let best = null;
  const attempts = [];
  const consider = async (cand, psm) => {
    const data = await recognizeWithRetry(state, c, cand.image, psm);
    const words = flattenWords(data, pageNumber);
    const conf = meanConf(words);
    // quality indicator = mean word conf, lightly rewarded for recovering more words
    const quality = (conf ?? 0) * Math.min(1, Math.log10(words.length + 1) / 1.5);
    attempts.push({ variant: cand.name, psm, wordCount: words.length, meanConfidence: conf === null ? null : Number(conf.toFixed(1)) });
    if (!best || quality > best.quality) best = { quality, data, words, conf, variant: cand.name, psm, meta: cand.meta };
  };
  await consider(candidates[0], 3);
  for (let i = 1; i < candidates.length && (best.conf ?? 0) < c.goodConfidence; i += 1) await consider(candidates[i], 3);
  if ((best.conf ?? 0) < c.goodConfidence) await consider(candidates.find((x) => x.name === best.variant) || candidates[0], 6);
  return { text: String(best.data.text || "").trim(), words: best.words, averageConfidence: best.conf, variant: best.variant, psm: best.psm, skew: best.meta && best.meta.skew || null, attempts };
}

async function rasterizePage(pdfPath, pageNumber, outDir, dpi, timeoutMs) {
  const prefix = path.join(outDir, `p${pageNumber}`);
  try {
    await execFileAsync("pdftoppm", ["-png", "-gray", "-r", String(dpi), "-f", String(pageNumber), "-l", String(pageNumber), pdfPath, prefix], { timeout: timeoutMs });
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("pdftoppm not found — install poppler-utils (apt-get install -y poppler-utils).");
    throw new Error(`PDF page ${pageNumber} rendering failed: ${String(err.stderr || err.message).slice(0, 160)}`);
  }
  const f = fs.readdirSync(outDir).find((n) => n.startsWith(`p${pageNumber}-`) && n.endsWith(".png"));
  if (!f) throw new Error(`PDF page ${pageNumber} produced no image.`);
  return path.join(outDir, f);
}

/**
 * OCR a set of "jobs": [{ pageNumber, imagePath? , pdfPath? }]. Rasterises PDF
 * pages lazily (one at a time) into a private temp dir that is always removed.
 * Returns pages[] with per-page success/error (partial failures never abort).
 */
async function recognizePages(jobs, { pdfPath } = {}) {
  const c = cfg();
  if (jobs.length > c.maxPages) throw new Error(`Document has ${jobs.length} pages needing OCR; limit is OCR_MAX_PAGES=${c.maxPages}.`);
  await acquire(c.maxConcurrentJobs);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evault-ocr-"));
  const state = { worker: null };
  const pages = [];
  try {
    state.worker = await newWorker(c);
    for (const job of jobs) {
      const started = Date.now();
      try {
        const imagePath = job.imagePath || await rasterizePage(pdfPath, job.pageNumber, tmpDir, c.dpi, c.pageTimeoutMs);
        const r = await ocrImage(state, c, imagePath, job.pageNumber);
        pages.push({ pageNumber: job.pageNumber, text: r.text, words: r.words, averageConfidence: r.averageConfidence, source: "ocr", engine: "tesseract",
          diagnostics: { variant: r.variant, psm: r.psm, skew: r.skew, attempts: r.attempts, durationMs: Date.now() - started } });
      } catch (err) {
        pages.push({ pageNumber: job.pageNumber, text: "", words: [], averageConfidence: null, source: "ocr", engine: "tesseract", error: String(err.message || err).slice(0, 300), errorCode: err.code || null });
      }
    }
    return pages;
  } finally {
    try { if (state.worker) await state.worker.terminate(); } catch (_) { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    release();
  }
}

module.exports = { recognizePages, _internals: { flattenWords, meanConf, cfg, withTimeout } };
