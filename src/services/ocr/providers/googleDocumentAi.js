// src/services/ocr/providers/googleDocumentAi.js
// Google Cloud Document AI (v1) adapter — real SDK, explicit per-tenant
// service-account credentials (never ADC / server env), no automatic retries
// (a retried processDocument could be billed twice).
const fs = require("fs");
const path = require("path");
const { ProviderError } = require("./baseProvider");
const { redact } = require("../credentialVault");

const KEY = "GOOGLE_DOCUMENT_AI";
const MAX_BYTES = Number(process.env.OCR_PROVIDER_MAX_BYTES || 20 * 1024 * 1024); // online-processing limit is documented by Google; keep conservative
const MAX_PAGES = Number(process.env.OCR_PROVIDER_MAX_PAGES || 15);
const TIMEOUT_MS = Number(process.env.OCR_PROVIDER_TIMEOUT_MS || 90000);
const MIME = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tif": "image/tiff", ".tiff": "image/tiff", ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp" };

// Strict allow-lists => no user-controlled hostnames (SSRF). The API host is
// built *only* from a validated location token.
const LOCATION_RE = /^(us|eu|[a-z]+(?:-[a-z]+)?[0-9]+)$/;
const PROJECT_RE = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|\d{6,16})$/;
const PROCESSOR_RE = /^[A-Za-z0-9_-]{6,64}$/;
const SA_EMAIL_RE = /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

function validateConfig(config = {}) {
  const errors = {}; const value = {};
  const projectId = String(config.projectId ?? "").trim();
  const location = String(config.location ?? "").trim().toLowerCase();
  const processorId = String(config.processorId ?? "").trim();
  if (!PROJECT_RE.test(projectId)) errors.projectId = "Enter the Google Cloud project ID (6–30 chars, lowercase letters/digits/hyphens) or project number.";
  if (!LOCATION_RE.test(location)) errors.location = 'Enter a valid Document AI location such as "us", "eu" or "asia-south1".';
  if (!PROCESSOR_RE.test(processorId)) errors.processorId = "Enter the processor ID (the final segment of the processor resource name).";
  Object.assign(value, { projectId, location, processorId });
  return { ok: !Object.keys(errors).length, errors, value };
}

function validateCredentials(raw) {
  const errors = {};
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch (_) { return { ok: false, errors: { credentials: "Credentials must be the service-account JSON key file contents." } }; } }
  if (!obj || typeof obj !== "object") return { ok: false, errors: { credentials: "Service-account JSON is required." } };
  if (obj.type !== "service_account") errors.credentials = 'JSON must be a service-account key ("type": "service_account").';
  else if (!SA_EMAIL_RE.test(String(obj.client_email || ""))) errors.credentials = "client_email must be a Google service-account address.";
  else if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(String(obj.private_key || ""))) errors.credentials = "private_key is missing or malformed.";
  else if (obj.token_uri && obj.token_uri !== GOOGLE_TOKEN_URI) errors.credentials = "Unexpected token_uri; only Google's OAuth endpoint is permitted.";
  if (Object.keys(errors).length) return { ok: false, errors };
  // Persist only what is needed to authenticate.
  return { ok: true, errors: {}, value: { type: "service_account", client_email: obj.client_email, private_key: obj.private_key, project_id: obj.project_id, token_uri: GOOGLE_TOKEN_URI } };
}

function buildClient({ config, credentials }) {
  const { DocumentProcessorServiceClient } = require("@google-cloud/documentai").v1;
  return new DocumentProcessorServiceClient({
    apiEndpoint: `${config.location}-documentai.googleapis.com`,
    credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
    projectId: config.projectId,
    fallback: false,
  });
}

function noRetry() {
  const gax = require("google-gax");
  return gax.createRetryOptions([], gax.createBackoffSettings(100, 1.3, 1000, TIMEOUT_MS, 1, TIMEOUT_MS, TIMEOUT_MS + 1000));
}

function mapError(err) {
  const msg = redact(err && (err.details || err.message) || "Provider error").slice(0, 300);
  switch (err && err.code) {
    case 16: return new ProviderError("AUTH_FAILED", "Google rejected the service-account credentials.");
    case 7: return new ProviderError("PERMISSION_DENIED", "The service account lacks permission to use this processor (needs Document AI API User role) or the API is disabled.");
    case 5: return new ProviderError("INVALID_PROCESSOR", "Processor not found. Check project, location and processor ID — the location must match where the processor was created.");
    case 3: return new ProviderError("INVALID_CONFIG", `Google rejected the request as invalid: ${msg}`);
    case 8: return new ProviderError("QUOTA_EXCEEDED", "Google quota or rate limit reached. Try again later.", { transient: true });
    case 4: case 14: return new ProviderError("NETWORK_TIMEOUT", "Google Document AI did not respond in time or is unreachable.", { transient: true });
    default:
      if (err && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(String(err.code || err.message))) return new ProviderError("ENDPOINT_MISMATCH", "Could not reach the Document AI endpoint for this location (invalid location or no network).", { transient: true });
      if (err instanceof ProviderError) return err;
      return new ProviderError("PROVIDER_ERROR", msg);
  }
}

// Genuine, non-billable request: processors.get on the configured processor.
async function testConnection({ config, credentials, client }) {
  const c = client || buildClient({ config, credentials });
  const name = c.processorPath(config.projectId, config.location, config.processorId);
  try {
    const [processor] = await c.getProcessor({ name }, { timeout: 30000, retry: noRetry() });
    // state: 1/ENABLED
    const state = String(processor.state);
    if (state !== "ENABLED" && state !== "1") return { ok: false, code: "INVALID_PROCESSOR", message: `Processor exists but is not enabled (state: ${state}).` };
    return { ok: true, code: "CONNECTED", message: "Connected to Google Document AI.", details: { processorType: processor.type || null, displayName: processor.displayName || null } };
  } catch (err) {
    const e = mapError(err); return { ok: false, code: e.code, message: e.message };
  } finally { if (!client && c.close) c.close().catch(() => {}); }
}

// ── Response → common ocrData shape ─────────────────────────────
function anchorText(fullText, anchor) {
  if (!anchor || !anchor.textSegments) return "";
  return anchor.textSegments.map((s) => fullText.slice(Number(s.startIndex || 0), Number(s.endIndex || 0))).join("");
}
function bboxOf(layout, page) {
  const v = (layout && layout.boundingPoly && (layout.boundingPoly.vertices && layout.boundingPoly.vertices.length ? layout.boundingPoly.vertices : null)) || null;
  const nv = layout && layout.boundingPoly && layout.boundingPoly.normalizedVertices;
  const pts = v && v.some((p) => p.x || p.y) ? v : (nv && nv.length ? nv.map((p) => ({ x: (p.x || 0) * (page.dimension ? page.dimension.width : 1), y: (p.y || 0) * (page.dimension ? page.dimension.height : 1) })) : null);
  if (!pts) return { x0: null, y0: null, x1: null, y1: null };
  const xs = pts.map((p) => p.x || 0), ys = pts.map((p) => p.y || 0);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function convertDocument(document) {
  const fullText = document.text || "";
  const pages = (document.pages || []).map((page, idx) => {
    const pageNumber = page.pageNumber || idx + 1;
    const words = (page.tokens || []).map((t, i) => ({
      text: anchorText(fullText, t.layout && t.layout.textAnchor).trim(),
      confidence: t.layout && Number.isFinite(t.layout.confidence) ? Math.round(t.layout.confidence * 1000) / 10 : null,
      page: pageNumber, line: null, order: i, source: "google-document-ai", bbox: bboxOf(t.layout, page),
    })).filter((w) => w.text);
    const lines = (page.lines || []).map((l) => anchorText(fullText, l.layout && l.layout.textAnchor).replace(/\s+$/g, "")).filter(Boolean);
    const text = (lines.length ? lines.join("\n") : anchorText(fullText, page.layout && page.layout.textAnchor)).trim();
    const confs = words.filter((w) => w.confidence !== null).map((w) => w.confidence);
    return { pageNumber, text, words, averageConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null, source: "provider", engine: KEY, width: page.dimension && page.dimension.width, height: page.dimension && page.dimension.height };
  });
  const entities = (document.entities || []).map((e) => ({
    type: e.type, mentionText: e.mentionText || "", confidence: Number.isFinite(e.confidence) ? e.confidence : null,
    normalizedValue: e.normalizedValue && (e.normalizedValue.text || null),
    page: e.pageAnchor && e.pageAnchor.pageRefs && e.pageAnchor.pageRefs[0] ? Number(e.pageAnchor.pageRefs[0].page || 0) + 1 : null,
  }));
  const confs = pages.filter((p) => p.averageConfidence !== null).map((p) => p.averageConfidence);
  return {
    provider: KEY, engine: KEY, pageCount: pages.length, pages, extractedText: pages.map((p) => p.text).filter(Boolean).join("\n\n"),
    averageConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
    pagesFailed: 0, status: "COMPLETED", sources: ["provider"], providerEntities: entities, warnings: [],
  };
}

async function countPdfPages(buf) {
  try { const { PDFDocument } = require("pdf-lib"); return (await PDFDocument.load(buf, { ignoreEncryption: true })).getPageCount(); } catch (_) { return null; }
}

async function processDocumentFile({ filePath, config, credentials, client }) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME[ext];
  if (!mimeType) throw new ProviderError("UNSUPPORTED_DOCUMENT", `File type "${ext}" is not supported by Document AI.`);
  const buf = fs.readFileSync(filePath);
  if (buf.length > MAX_BYTES) throw new ProviderError("UNSUPPORTED_DOCUMENT", `File is ${(buf.length / 1048576).toFixed(1)} MB; the online-processing limit configured here is ${(MAX_BYTES / 1048576).toFixed(0)} MB.`);
  if (ext === ".pdf") { const n = await countPdfPages(buf); if (n && n > MAX_PAGES) throw new ProviderError("UNSUPPORTED_DOCUMENT", `PDF has ${n} pages; online processing is limited to ${MAX_PAGES} pages here.`); }
  const c = client || buildClient({ config, credentials });
  const name = c.processorPath(config.projectId, config.location, config.processorId);
  const started = Date.now();
  try {
    // Exactly ONE billable call. retry disabled so a transport hiccup cannot cause a duplicate charge.
    const [result] = await c.processDocument({ name, rawDocument: { content: buf, mimeType } }, { timeout: TIMEOUT_MS, retry: noRetry() });
    if (!result || !result.document) throw new ProviderError("PROVIDER_ERROR", "Document AI returned an empty response.");
    const data = convertDocument(result.document);
    data.durationMs = Date.now() - started;
    return data;
  } catch (err) { throw mapError(err); }
  finally { if (!client && c.close) c.close().catch(() => {}); }
}

module.exports = { key: KEY, displayName: "Google Cloud Document AI", validateConfig, validateCredentials, testConnection, process: processDocumentFile, _internals: { convertDocument, mapError, buildClient } };
