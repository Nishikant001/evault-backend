// src/services/ocr/preprocess.js
// Image preprocessing with the already-installed `canvas` package (no new
// native dependency). Produces a *bounded* set of variants; the caller picks
// the winner by measured OCR quality rather than applying transforms blindly.
// `canvas` is a native module; load lazily so a platform/binary problem degrades
// to "no preprocessing" (raw image OCR) instead of breaking OCR entirely.
let _canvas = null; let _canvasError = null;
function canvasLib() {
  if (_canvas) return _canvas;
  if (_canvasError) throw _canvasError;
  try { _canvas = require("canvas"); return _canvas; }
  catch (err) { _canvasError = new Error(`Image preprocessing unavailable (canvas failed to load: ${String(err.message).slice(0, 120)}). Run "npm rebuild canvas" on this platform.`); throw _canvasError; }
}
const createCanvas = (...a) => canvasLib().createCanvas(...a);
const loadImage = (...a) => canvasLib().loadImage(...a);

const SKEW_MAX_DEG = 6;
const SKEW_STEP_DEG = 0.5;
const SKEW_APPLY_MIN_DEG = 0.75; // below this, rotation costs more than it gains

function toGray(imageData) {
  const { data, width, height } = imageData;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  return gray;
}

// Percentile contrast stretch (robust to a few dark/bright outliers).
function stretchContrast(gray) {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  const find = (frac) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * frac) return i; } return 255; };
  const lo = find(0.01), hi = find(0.99);
  if (hi - lo < 20) return gray; // already flat/degenerate — leave untouched
  const out = new Uint8ClampedArray(gray.length);
  const scale = 255 / (hi - lo);
  for (let i = 0; i < gray.length; i++) out[i] = Math.max(0, Math.min(255, (gray[i] - lo) * scale));
  return out;
}

function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

// Adaptive (local-mean) threshold via integral image: good for uneven lighting.
function adaptiveThreshold(gray, width, height, windowSize = 31, offset = 10) {
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      rowSum += gray[(y - 1) * width + (x - 1)];
      integral[y * (width + 1) + x] = integral[(y - 1) * (width + 1) + x] + rowSum;
    }
  }
  const out = new Uint8ClampedArray(gray.length);
  const r = Math.floor(windowSize / 2);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(height - 1, y + r);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(width - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s = integral[(y1 + 1) * (width + 1) + (x1 + 1)] - integral[y0 * (width + 1) + (x1 + 1)]
        - integral[(y1 + 1) * (width + 1) + x0] + integral[y0 * (width + 1) + x0];
      out[y * width + x] = gray[y * width + x] < s / area - offset ? 0 : 255;
    }
  }
  return out;
}

// Projection-profile skew estimation on a downscaled binary image. Returns
// degrees (positive = clockwise skew) and a score so callers can ignore weak
// estimates (e.g. photos with no text lines).
function estimateSkew(gray, width, height) {
  const target = 600;
  const step = Math.max(1, Math.floor(Math.max(width, height) / target));
  const w = Math.floor(width / step), h = Math.floor(height / step);
  if (w < 50 || h < 50) return { angle: 0, confidence: 0 };
  const pts = [];
  const thr = otsuThreshold(gray);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (gray[y * step * width + x * step] < thr) pts.push(x - w / 2, y - h / 2);
  if (pts.length < 200) return { angle: 0, confidence: 0 };
  const variance = (deg) => {
    const rad = (deg * Math.PI) / 180, sin = Math.sin(rad), cos = Math.cos(rad);
    const bins = new Float64Array(h * 2);
    for (let i = 0; i < pts.length; i += 2) {
      const yr = Math.round(-pts[i] * sin + pts[i + 1] * cos + h);
      if (yr >= 0 && yr < bins.length) bins[yr]++;
    }
    let mean = 0; for (const b of bins) mean += b; mean /= bins.length;
    let v = 0; for (const b of bins) v += (b - mean) ** 2;
    return v / bins.length;
  };
  let bestAngle = 0, bestVar = -1, zeroVar = variance(0);
  for (let a = -SKEW_MAX_DEG; a <= SKEW_MAX_DEG + 1e-9; a += SKEW_STEP_DEG) {
    const v = variance(a);
    if (v > bestVar) { bestVar = v; bestAngle = a; }
  }
  const confidence = zeroVar > 0 ? bestVar / zeroVar : 0; // >1.05 means a real improvement over upright
  return { angle: Number(bestAngle.toFixed(2)), confidence };
}

function grayToCanvas(gray, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) { img.data[i] = img.data[i + 1] = img.data[i + 2] = gray[p]; img.data[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function rotateCanvas(src, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const w = src.width, h = src.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2); ctx.rotate(rad); ctx.drawImage(src, -w / 2, -h / 2);
  return canvas;
}

/**
 * Build preprocessing variants for an image file. Order matters: callers
 * evaluate the first variant, and only try later ones if quality is low.
 * Returns [{ name, buffer, meta }]. Memory is bounded by MAX_VARIANTS.
 */
async function buildVariants(imagePath, { maxVariants = 3, maxPixels = 40e6 } = {}) {
  const img = await loadImage(imagePath);
  if (img.width * img.height > maxPixels) {
    // Refuse to allocate huge canvases; caller falls back to the raw file.
    return [];
  }
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  const gray = stretchContrast(toGray(imageData));
  const { width, height } = img;
  const skew = estimateSkew(gray, width, height);
  const applySkew = Math.abs(skew.angle) >= SKEW_APPLY_MIN_DEG && skew.confidence > 1.05;

  const variants = [];
  let base = grayToCanvas(gray, width, height);
  if (applySkew) base = rotateCanvas(base, -skew.angle);
  variants.push({ name: applySkew ? "gray-deskew" : "gray-normalized", canvas: base, meta: { skew } });

  if (variants.length < maxVariants) {
    const bin = adaptiveThreshold(gray, width, height);
    let c = grayToCanvas(bin, width, height);
    if (applySkew) c = rotateCanvas(c, -skew.angle);
    variants.push({ name: "adaptive-binary", canvas: c, meta: { skew } });
  }
  if (variants.length < maxVariants) {
    const t = otsuThreshold(gray);
    const bin = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) bin[i] = gray[i] < t ? 0 : 255;
    let c = grayToCanvas(bin, width, height);
    if (applySkew) c = rotateCanvas(c, -skew.angle);
    variants.push({ name: "otsu-binary", canvas: c, meta: { skew } });
  }
  return variants.map((v) => ({ name: v.name, buffer: v.canvas.toBuffer("image/png"), meta: v.meta }));
}

module.exports = { buildVariants, estimateSkew, otsuThreshold, stretchContrast, adaptiveThreshold };
