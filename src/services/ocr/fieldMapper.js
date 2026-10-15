// src/services/ocr/fieldMapper.js
// Pure (no DB) template-driven field mapping. Input: the template's fields
// (label/internalName/type/aliases/validation) + OCR text/words. Output: for
// EVERY configured field a mapped value (or null), plus provenance, candidates,
// ambiguity flags and an explainable heuristic confidence.
//
// Scoring (documented in docs/OCR_UPGRADE.md):
//   score = weighted mean of the components that actually have evidence:
//     label(0.30)    exact label/alias match quality
//     layout(0.20)   same-line (1.0) vs next-line (0.8) vs text-fallback (0.7)
//     validation(0.30) field-type/format check
//     ocr(0.20)      mean word confidence of the value's words (only when measured)
//   Missing evidence is EXCLUDED and weights renormalised — it is never replaced
//   by a flattering default. Validation failure caps the result at LOW, ambiguity
//   at MID. The score is a heuristic ranking aid, NOT a probability of correctness.
const OcrService = require("../ocrService");
const {
  FIELD_TYPES,
  CONFIDENCE_LEVELS,
  NON_OCR_FIELD_TYPES,
} = require("../../constants/metadataFieldTypes");
const N = require("./normalizers");
const { boundaryFor } = require("./labelDictionary");

const norm = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

function aliasesFor(field) {
  const out = [field.label, field.internalName];
  for (const a of field.ocrAliases || [])
    if (a && a.status !== "INACTIVE") out.push(a.alias);
  return [
    ...new Set(
      out.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()),
    ),
  ];
}

function isGstinField(field) {
  return (
    /\bgstin\b|\bgst\s*(no|number|id)\b/i.test(
      [
        field.label,
        field.internalName,
        ...(field.ocrAliases || []).map((a) => a && a.alias),
      ].join(" "),
    ) ||
    (field.validation && field.validation.gstValidation)
  );
}
function isPanField(field) {
  return /\bpan\b/i.test([field.label, field.internalName].join(" "));
}

// Type-aware normalize + validate. Returns { value (normalized for storage), display original, valid, formatScore, warnings[], alternatives[] }
function normalizeValue(field, raw, otherLabels, opts) {
  const original = N.collapseWhitespace(raw);
  let cleaned = N.stripTrailingLabels(
    original,
    otherLabels,
    opts.colonLabels || [],
  );
  const type = String(field.fieldType || "TEXT").toUpperCase();
  const warnings = [];
  let alternatives = [];
  const r = (value, valid, formatScore, extra = {}) => ({
    original,
    value,
    valid,
    formatScore,
    warnings,
    alternatives,
    ...extra,
  });

  if (!cleaned) return r(null, false, 0);
  if (type === FIELD_TYPES.DATE) {
    const d = N.parseDate(cleaned, { dayFirst: opts.dayFirst });
    if (!d.ok) return r(cleaned, false, 0.1, { reason: d.reason });
    if (d.ambiguous)
      warnings.push(
        "Date could be day-first or month-first; interpreted as day-first. Please verify.",
      );
    return r(d.iso, true, d.ambiguous ? 0.6 : 1, { ambiguous: d.ambiguous });
  }
  if (type === FIELD_TYPES.NUMBER || type === FIELD_TYPES.CURRENCY) {
    const a = N.parseAmount(cleaned);
    if (!a.ok) return r(cleaned, false, 0.1, { reason: a.reason });
    if (a.ambiguous)
      warnings.push(
        "Separator is ambiguous (thousands vs decimal). Please verify.",
      );
    return r(a.normalized, true, a.ambiguous ? 0.55 : 1, {
      ambiguous: a.ambiguous,
    });
  }
  if (type === FIELD_TYPES.EMAIL) {
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned);
    return r(cleaned, ok, ok ? 1 : 0.1);
  }
  if (type === FIELD_TYPES.PHONE) {
    const d = cleaned.replace(/\D/g, "");
    const ok = d.length >= 7 && d.length <= 15;
    return r(cleaned, ok, ok ? 1 : 0.25);
  }
  if (isGstinField(field)) {
    const g = N.validateGstin(cleaned);
    if (!g.valid) {
      alternatives = N.gstinAlternatives(cleaned);
      if (alternatives.length)
        warnings.push(
          "Value is not a valid GSTIN; a possible OCR confusion alternative exists. Please verify.",
        );
      return r(g.value, false, 0.15, { alternatives });
    }
    if (!g.checksum)
      warnings.push(
        "GSTIN format is valid but its check digit does not verify. Please verify against the source document.",
      );
    return r(g.value, true, g.checksum ? 1 : 0.6);
  }
  if (isPanField(field)) {
    const p = N.validatePan(cleaned);
    return r(p.value, p.valid, p.valid ? 1 : 0.15);
  }
  // identifiers & free text: preserve characters, trim punctuation only
  const looksId = /\b(no|number|id|code|batch|invoice|po)\b/i.test(
    field.label + " " + field.internalName,
  );
  return r(
    looksId ? N.normalizeIdentifier(cleaned) : cleaned,
    true,
    looksId ? 0.75 : 0.7,
  );
}

// ── candidate discovery ────────────────────────────────────────
const escRe = (v) =>
  String(v)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");

// Kya text kisi known label se shuru ho raha hai? (header row pehchanne ke liye)
function startsWithLabel(text, labels, colonLabels) {
  const t = String(text || "").trim();
  if (!t) return false;
  const all = [...labels].sort((a, b) => b.length - a.length);
  if (all.some((l) => new RegExp(`^${escRe(l)}(?![A-Za-z0-9])`, "i").test(t)))
    return true;
  return colonLabels.some((l) =>
    new RegExp(`^${escRe(l)}\\s*[:=]`, "i").test(t),
  );
}

const splitCells = (line) =>
  String(line || "")
    .trim()
    .split(/\s{2,}|\t|\s*\|\s*/)
    .filter(Boolean);

// Header row / value row layout: usi column ki value uthata hai. Align na ho to null (guess nahi).
function headerRowValue(rawHeader, rawValue, alias, labels, colonLabels) {
  const hCells = splitCells(rawHeader),
    vCells = splitCells(rawValue);
  if (hCells.length >= 2 && hCells.length === vCells.length) {
    const idx = hCells.findIndex((c) => norm(c).startsWith(norm(alias)));
    if (idx >= 0) return vCells[idx];
  }
  const alt = [...new Set([alias, ...labels])]
    .sort((a, b) => b.length - a.length)
    .map(escRe)
    .join("|");
  const colonAlt = colonLabels.map((l) => `${escRe(l)}(?=\\s*[:=])`).join("|");
  const re = new RegExp(
    `(?:^|[\\s|])(${alt}${colonAlt ? "|" + colonAlt : ""})(?![A-Za-z0-9])`,
    "gi",
  );
  const found = [];
  let m;
  while ((m = re.exec(rawHeader))) found.push(m[1]);
  const tokens = String(rawValue || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (found.length >= 2 && tokens.length === found.length) {
    const idx = found.findIndex((f) => norm(f) === norm(alias));
    if (idx >= 0) return tokens[idx];
  }
  return null;
}

function lineCandidates(text, aliases, labels, colonLabels = []) {
  const found = [];
  const rawLines = String(text || "")
    .replace(/\r/g, "")
    .split("\n");
  const lines = rawLines.map((l) => l.replace(/[\t ]+/g, " ").trim());
  const sorted = [...aliases].sort((a, b) => b.length - a.length);
  lines.forEach((line, i) => {
    if (!line) return;
    for (const alias of sorted) {
      const re = new RegExp(
        `(?:^|[\\s|;,])(${escRe(alias).replace(/\\s\+/g, "\\s*")})(?![A-Za-z0-9])\\s*(?::|=|#|-|–|—)?\\s*`,
        "gi",
      );
      const hits = [];
      let m;
      while ((m = re.exec(line))) {
        const aliasStart = m.index + m[0].indexOf(m[1]);
        const prefix = line.slice(0, aliasStart);
        // "Amount" jaisa chhota alias "Taxable Amount" ka tail ho to skip
        if (
          labels.some(
            (o) =>
              o.length > alias.length &&
              norm(o).endsWith(norm(alias)) &&
              norm(prefix + alias).endsWith(norm(o)),
          )
        )
          continue;
        hits.push({ aliasStart, valueStart: m.index + m[0].length });
      }
      hits.forEach((h, idx) => {
        let value = line
          .slice(
            h.valueStart,
            idx + 1 < hits.length ? hits[idx + 1].aliasStart : undefined,
          )
          .trim();
        let strategy = "same-line";
        let lineIndex = i;

        // Header row: label ke baad agle column ka label aa gaya
        if (value && startsWithLabel(value, labels, colonLabels)) {
          let n = i + 1;
          while (n < lines.length && !lines[n]) n++;
          const v =
            n < lines.length && n <= i + 2
              ? headerRowValue(
                  rawLines[i],
                  rawLines[n],
                  alias,
                  labels,
                  colonLabels,
                )
              : null;
          if (!v) return;
          value = v;
          strategy = "header-row";
          lineIndex = n;
                } else if (!value) {
          for (let n = i + 1; n < lines.length && n <= i + 2; n++) {
            if (!lines[n]) continue;
            if (/[:=]$/.test(lines[n])) break;
            // Side-by-side blocks: agar kisi line me kai column-cells hain to value sirf
            // usi column se lo. Column match na ho to guess mat karo (coordinates decide karenge).
            const hCells = splitCells(rawLines[i]), vCells = splitCells(rawLines[n]);
            if (hCells.length >= 2 || vCells.length >= 2) {
              const idx = hCells.findIndex((c) => norm(c).startsWith(norm(alias)));
              if (hCells.length === vCells.length && idx >= 0) { value = vCells[idx]; strategy = "next-line"; lineIndex = n; }
              break;
            }
            value = lines[n]; strategy = "next-line"; lineIndex = n; break;
          }
        }
        if (!value) return;
        found.push({
          value,
          matchedAlias: alias,
          strategy: `text-${strategy}`,
          lineIndex,
          layoutScore:
            strategy === "same-line"
              ? 1
              : strategy === "header-row"
                ? 0.9
                : 0.8,
          page: null,
        });
      });
      if (hits.length) break;
    }
  });
  return found;
}

function wordConfidence(value, ocrData) {
  const target = norm(value);
  if (!target || !ocrData || !Array.isArray(ocrData.pages)) return null;
  for (const page of ocrData.pages) {
    const words = (page.words || []).filter((w) => w && w.text);
    for (let s = 0; s < words.length; s++) {
      let combined = "";
      const confs = [];
      for (let e = s; e < Math.min(words.length, s + 12); e++) {
        combined += norm(words[e].text);
        if (Number.isFinite(words[e].confidence))
          confs.push(words[e].confidence);
        if (combined === target)
          return confs.length
            ? {
                mean: confs.reduce((a, b) => a + b, 0) / confs.length / 100,
                min: Math.min(...confs) / 100,
                page: page.pageNumber,
                source: words[s].source || page.source || null,
              }
            : {
                mean: null,
                min: null,
                page: page.pageNumber,
                source: words[s].source || page.source || null,
              };
        if (!target.startsWith(combined)) break;
      }
    }
  }
  return null;
}

const levelFor = (score, threshold) => {
  const min = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.6;
  return score >= Math.max(min, 0.85)
    ? CONFIDENCE_LEVELS.HIGH
    : score >= min
      ? CONFIDENCE_LEVELS.MID
      : CONFIDENCE_LEVELS.LOW;
};

function entityCandidates(field, entities) {
  const keys = new Set(aliasesFor(field).map(norm));
  return (entities || [])
    .filter((e) => e && e.mentionText && keys.has(norm(e.type)))
    .map((e) => ({
      value:
        e.normalizedValue && field.fieldType !== FIELD_TYPES.TEXT
          ? e.normalizedValue
          : e.mentionText,
      matchedAlias: e.type,
      strategy: "provider-entity",
      layoutScore: 0.95,
      page: e.page,
      providerConfidence: e.confidence,
    }));
}

function mapFields({
  fields,
  extractedText,
  ocrData,
  spatialFinder,
  dayFirst = true,
}) {
  const mapped = {};
  const confidence = {};
  const allAliases = fields.flatMap(aliasesFor);
  const used = new Set();
  const ordered = fields
    .slice()
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

  for (const field of ordered) {
    if (NON_OCR_FIELD_TYPES.includes(field.fieldType)) {
      if (
        field.defaultValue !== undefined &&
        field.defaultValue !== null &&
        field.defaultValue !== ""
      ) {
        mapped[field.internalName] = field.defaultValue;
        confidence[field.internalName] = {
          confidence: CONFIDENCE_LEVELS.HIGH,
          score: 1,
          scoreType: "configured-default",
          source: "default",
          status: "DEFAULT",
        };
      }
      continue;
    }
    const aliases = aliasesFor(field);
    const ownNorm = new Set(aliases.map(norm));
    const templateOthers = allAliases.filter((a) => !ownNorm.has(norm(a)));
    const boundary = boundaryFor(aliases);
    const otherAliases = [...new Set([...templateOthers, ...boundary.labels])];
    const raw = [];
    if (spatialFinder) {
      const sp = spatialFinder(ocrData, aliases, [
        ...allAliases,
        ...boundary.labels,
      ]);
      if (sp)
        raw.push({
          ...sp,
          strategy: sp.strategy,
          layoutScore: sp.strategy === "spatial-same-line" ? 1 : 0.85,
        });
    }
        raw.push(...lineCandidates(extractedText, aliases, otherAliases, boundary.colonLabels));
    // Jo text candidate coordinates wale candidate ko sirf aage badhata hai (value + padosi column ka
    // text), wo cross-column merge hai: hata do.
    const spatial = raw.find((c) => String(c.strategy).startsWith("spatial"));
    if (spatial) {
      const sv = norm(spatial.value);
      for (let k = raw.length - 1; k >= 0; k -= 1) {
        const c = raw[k];
        if (c !== spatial && /^text-(next-line|header-row)$/.test(c.strategy) && sv && norm(c.value) !== sv && norm(c.value).includes(sv)) raw.splice(k, 1);
      }
    }
    raw.push(...entityCandidates(field, ocrData && ocrData.providerEntities));

    // normalise + dedupe by normalised value
    const byValue = new Map();
    for (const c of raw) {
      // own aliases are stripped too, so a repeated own label ("Batch No: A Batch No: B") cannot leak into a value
      const nv = normalizeValue(field, c.value, [...otherAliases, ...aliases], {
        dayFirst,
        colonLabels: boundary.colonLabels,
      });
      if (!nv.value) continue;
      const wc =
        c.ocrConfidence !== undefined && c.ocrConfidence !== null
          ? { mean: c.ocrConfidence, page: c.pageNumber }
          : wordConfidence(nv.original, ocrData) ||
            wordConfidence(nv.value, ocrData);
      const exact =
        aliases.some((a) => norm(a) === norm(c.matchedAlias)) &&
        norm(field.label) === norm(c.matchedAlias);
      const parts = [
        { w: 0.3, v: exact ? 1 : 0.8 },
        { w: 0.2, v: c.layoutScore ?? 0.7 },
        { w: 0.3, v: nv.formatScore },
      ];
      if (c.providerConfidence !== undefined && c.providerConfidence !== null)
        parts.push({ w: 0.2, v: c.providerConfidence });
      else if (wc && wc.mean !== null && wc.mean !== undefined)
        parts.push({ w: 0.2, v: wc.mean });
      const wsum = parts.reduce((s, p) => s + p.w, 0);
      let score = parts.reduce((s, p) => s + p.w * p.v, 0) / wsum;
      const key = nv.value.toLowerCase();
      const cand = {
        value: nv.value,
        originalText: nv.original,
        valid: nv.valid,
        score: Number(Math.min(0.99, score).toFixed(2)),
        strategy: c.strategy,
        matchedAlias: c.matchedAlias,
        page: (wc && wc.page) || c.pageNumber || c.page || null,
        ocrConfidence:
          wc && wc.mean !== null && wc.mean !== undefined
            ? Number(wc.mean.toFixed(2))
            : (c.providerConfidence ?? null),
        evidenceSource:
          (wc && wc.source) ||
          (c.strategy === "provider-entity" ? "provider" : null),
        warnings: nv.warnings,
        alternatives: nv.alternatives,
        normalizedAmbiguity: !!nv.ambiguous,
      };
      const prev = byValue.get(key);
      if (!prev || cand.score > prev.score) byValue.set(key, cand);
    }
    const cands = [...byValue.values()].sort(
      (a, b) => Number(b.valid) - Number(a.valid) || b.score - a.score,
    );
    if (!cands.length) {
      mapped[field.internalName] =
        field.defaultValue !== undefined ? field.defaultValue : null;
      confidence[field.internalName] = {
        confidence: CONFIDENCE_LEVELS.LOW,
        score: 0,
        scoreType: "heuristic",
        source: "not-found",
        status: "NOT_DETECTED",
        validationPassed: false,
        candidates: [],
      };
      continue;
    }
    const best = cands[0];
    const validDistinct = cands.filter((c) => c.valid);
    const competing =
      validDistinct.length > 1 && validDistinct[1].score >= best.score - 0.1;
    let score = best.score;
    let status = "DETECTED";
    if (!best.valid) {
      score = Math.min(score, 0.45);
      status = "INVALID_FORMAT";
    } else if (competing) {
      score = Math.min(score, 0.7);
      status = "AMBIGUOUS";
    } else if (best.warnings.length) {
      score = Math.min(score, 0.7);
      status = "NEEDS_REVIEW";
    }
    if (used.has(String(best.value).toLowerCase()) && best.valid) {
      score = Math.max(0, score - 0.15);
      if (status === "DETECTED") status = "NEEDS_REVIEW";
      best.warnings = [
        ...best.warnings,
        "Same text was also mapped to another field.",
      ];
    }
    if (best.valid) used.add(String(best.value).toLowerCase());
    mapped[field.internalName] = best.value;
    confidence[field.internalName] = {
      confidence: levelFor(score, field.confidenceThreshold),
      score: Number(score.toFixed(2)),
      scoreType: "heuristic",
      source: best.strategy,
      matchedAlias: best.matchedAlias,
      validationPassed: best.valid,
      status,
      originalText: best.originalText,
      page: best.page,
      ocrConfidence: best.ocrConfidence,
      evidenceSource: best.evidenceSource,
      warnings: best.warnings,
      alternatives: best.alternatives,
      candidates: cands
        .slice(0, 5)
        .map((c) => ({
          value: c.value,
          originalText: c.originalText,
          score: c.score,
          valid: c.valid,
          strategy: c.strategy,
          page: c.page,
        })),
    };
  }
  return { mapped, confidence };
}

module.exports = { mapFields, aliasesFor, normalizeValue, wordConfidence };
