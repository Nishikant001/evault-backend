// src/services/ocr/normalizers.js
// Domain-aware, conservative normalization + validation helpers.
// Principles: never destroy the original OCR text (callers keep it), never
// "fix" characters blindly (O/0, I/1, S/5), and never invent values.

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function collapseWhitespace(value) {
  return String(value ?? "").replace(/[\u00a0\t ]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
}

// Remove a *known* neighbouring label that was swallowed into a value, e.g.
// "PH-INV-1  Invoice Date" -> "PH-INV-1". Only strips labels supplied by the
// caller (other configured field aliases), so we never guess.
function stripTrailingLabels(value, knownLabels = [], colonLabels = []) {
  let out = collapseWhitespace(value);
  const prep = (list, colon) => [...new Set(list.map((l) => collapseWhitespace(l)).filter((l) => l.length >= 3))].map((label) => ({ label, colon }));
  // longest label first so "Total Invoice Amount" wins over "Amount"
  const entries = [...prep(knownLabels, false), ...prep(colonLabels, true)].sort((a, b) => b.label.length - a.label.length);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { label, colon } of entries) {
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      // colon-only labels must be followed by ":" or "="
      const re = colon
        ? new RegExp(`\\s*[|:;,-]?\\s*\\b${esc}\\s*[:=]\\s*.*$`, "i")
        : new RegExp(`\\s*[|:;,-]?\\s*\\b${esc}\\b\\s*[:=#.]*\\s*.*$`, "i");
      const m = out.match(re);
      if (m && m.index > 0) { out = out.slice(0, m.index).trim(); changed = true; break; }
    }
  }
  return out;
}

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12,
  january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };

function validYMD(y, m, d) {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Parse a date with an explicit, documented strategy.
 * - yyyy-mm-dd / yyyy/mm/dd / yyyy.mm.dd           => ISO order (unambiguous)
 * - dd-mm-yyyy / dd/mm/yyyy / dd.mm.yyyy           => DAY-FIRST by default (en-IN locale).
 *   Pass { dayFirst:false } for month-first tenants.
 * - dd Mon yyyy / Mon dd, yyyy                      => named month (unambiguous)
 * When both parts are <= 12 and the two orders give different dates, the
 * result is flagged `ambiguous:true` so the UI can ask for review.
 */
function parseDate(raw, { dayFirst = true } = {}) {
  const text = collapseWhitespace(raw);
  if (!text) return { ok: false, reason: "empty" };
  let m = text.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYMD(y, mo, d) ? { ok: true, iso: fmt(y, mo, d), ambiguous: false } : { ok: false, reason: "invalid-date" };
  }
  m = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    const [d, mo] = dayFirst ? [a, b] : [b, a];
    if (!validYMD(y, mo, d)) {
      // maybe the other order is the valid one
      const [d2, mo2] = dayFirst ? [b, a] : [a, b];
      return validYMD(y, mo2, d2) ? { ok: true, iso: fmt(y, mo2, d2), ambiguous: false, swapped: true } : { ok: false, reason: "invalid-date" };
    }
    const ambiguous = a <= 12 && b <= 12 && a !== b;
    return { ok: true, iso: fmt(y, mo, d), ambiguous };
  }
  m = text.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[ ,.-]+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const [d, mo, y] = [Number(m[1]), MONTHS[m[2].toLowerCase()], Number(m[3])];
    return validYMD(y, mo, d) ? { ok: true, iso: fmt(y, mo, d), ambiguous: false } : { ok: false, reason: "invalid-date" };
  }
  m = text.match(/^([A-Za-z]{3,9})[ .]+(\d{1,2}),?[ ]+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    const [mo, d, y] = [MONTHS[m[1].toLowerCase()], Number(m[2]), Number(m[3])];
    return validYMD(y, mo, d) ? { ok: true, iso: fmt(y, mo, d), ambiguous: false } : { ok: false, reason: "invalid-date" };
  }
  return { ok: false, reason: "unsupported-format" };
}
function fmt(y, m, d) { return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }

/**
 * Parse a monetary/numeric value. Handles ₹/$/€/£/Rs/INR prefixes,
 * Indian (12,34,567.89), western (1,234,567.89) and European (1.234.567,89)
 * grouping. A lone separator followed by exactly 3 digits is treated as a
 * thousands separator only when no other separator is present AND it occurs
 * as a repeated group; otherwise it is flagged ambiguous.
 */
function parseAmount(raw) {
  let text = collapseWhitespace(raw).replace(/^(?:rs\.?|inr|usd|eur|gbp|[₹$€£])\s*/i, "").replace(/\s*(?:rs\.?|inr|usd|eur|gbp)$/i, "");
  if (!text) return { ok: false, reason: "empty" };
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (text.startsWith("-")) { negative = !negative; text = text.slice(1); }
  text = text.replace(/\s/g, "");
  if (!/^\d[\d.,]*$/.test(text)) return { ok: false, reason: "not-numeric" };
  const lastDot = text.lastIndexOf("."), lastComma = text.lastIndexOf(",");
  let decimalSep = null, ambiguous = false;
  if (lastDot >= 0 && lastComma >= 0) decimalSep = lastDot > lastComma ? "." : ",";
  else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const count = text.split(sep).length - 1;
    const tail = text.slice(text.lastIndexOf(sep) + 1);
    if (count > 1) decimalSep = null;               // repeated => thousands
    else if (tail.length === 3) { decimalSep = null; ambiguous = true; } // "1,234" / "1.234"
    else decimalSep = sep;
  }
  let intPart = text, frac = "";
  if (decimalSep) {
    const idx = text.lastIndexOf(decimalSep);
    intPart = text.slice(0, idx); frac = text.slice(idx + 1);
  }
  intPart = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(intPart) || (frac && !/^\d+$/.test(frac))) return { ok: false, reason: "malformed" };
  const normalized = `${negative ? "-" : ""}${intPart}${frac ? "." + frac : ""}`;
  return { ok: true, value: Number(normalized), normalized, ambiguous };
}

function validateGstin(raw) {
  const v = collapseWhitespace(raw).replace(/\s/g, "").toUpperCase();
  if (!GSTIN_RE.test(v)) return { valid: false, value: v, reason: "format" };
  // Checksum (official mod-36 algorithm)
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = GSTIN_CHARSET.indexOf(v[i]);
    const factor = i % 2 === 0 ? 1 : 2;
    const prod = code * factor;
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  const check = GSTIN_CHARSET[(36 - (sum % 36)) % 36];
  return check === v[14] ? { valid: true, value: v, checksum: true } : { valid: true, value: v, checksum: false, reason: "checksum-mismatch" };
}

// Alternative GSTIN candidates differing by well-known OCR confusions. Returned
// ONLY when exactly the checksum+format validate; callers must treat a lone
// valid alternative as a *suggestion*, never silently substitute it.
function gstinAlternatives(raw) {
  const v = collapseWhitespace(raw).replace(/\s/g, "").toUpperCase();
  if (v.length !== 15) return [];
  const swaps = { O: "0", "0": "O", I: "1", "1": "I", S: "5", "5": "S", B: "8", "8": "B", Z: "2", "2": "Z" };
  const out = new Set();
  for (let i = 0; i < v.length; i++) {
    const s = swaps[v[i]];
    if (!s) continue;
    const cand = v.slice(0, i) + s + v.slice(i + 1);
    const r = validateGstin(cand);
    if (r.valid && r.checksum) out.add(cand);
  }
  return [...out];
}

function validatePan(raw) {
  const v = collapseWhitespace(raw).replace(/\s/g, "").toUpperCase();
  return { valid: PAN_RE.test(v), value: v };
}

// Identifier-like value (invoice no, PO no, batch no): keep characters, trim
// surrounding punctuation only.
function normalizeIdentifier(raw) {
  return collapseWhitespace(raw).replace(/^[\s:;|=#.,-]+|[\s:;|=,.]+$/g, "");
}

module.exports = {
  collapseWhitespace, stripTrailingLabels, parseDate, parseAmount,
  validateGstin, gstinAlternatives, validatePan, normalizeIdentifier,
};
