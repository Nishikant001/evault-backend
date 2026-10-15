// src/services/ocr/credentialVault.js
// Encrypt-at-rest for tenant OCR provider credentials.
//  - Key comes ONLY from OCR_CREDENTIAL_ENCRYPTION_KEY (env / secret manager),
//    never from the database, never from JWT_SECRET, and there is NO dev fallback.
//  - AES-256-GCM, random IV, HKDF-derived per-purpose key, and the tenant id is
//    bound as AAD so a ciphertext copied into another tenant's DB won't decrypt.
const crypto = require("crypto");

class VaultError extends Error { constructor(code, message) { super(message); this.code = code; } }

function masterKey() {
  const raw = process.env.OCR_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new VaultError("OCR_ENCRYPTION_KEY_MISSING",
      "OCR credential encryption is not configured on the server (set OCR_CREDENTIAL_ENCRYPTION_KEY to a random value of at least 32 characters). Credentials were not stored.");
  }
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.from("evault-ocr-credentials-v1"), Buffer.from("aes-256-gcm"), 32));
}

function isConfigured() { const raw = process.env.OCR_CREDENTIAL_ENCRYPTION_KEY; return !!raw && raw.length >= 32; }

function encrypt(plain, tenantId) {
  const key = masterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`tenant:${tenantId}`));
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

function decrypt(payload, tenantId) {
  if (!payload) return null;
  const key = masterKey();
  const [ver, ivB, tagB, dataB] = String(payload).split(":");
  if (ver !== "v1" || !ivB || !tagB || !dataB) throw new VaultError("OCR_CREDENTIAL_CORRUPT", "Stored OCR credentials are unreadable. Re-enter them in OCR Settings.");
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
    d.setAAD(Buffer.from(`tenant:${tenantId}`));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(dataB, "base64")), d.final()]).toString("utf8");
  } catch (_) {
    throw new VaultError("OCR_CREDENTIAL_UNDECRYPTABLE", "Stored OCR credentials could not be decrypted (encryption key changed or data belongs to another tenant). Re-enter them in OCR Settings.");
  }
}

// Remove anything credential-shaped from a string before it is logged/returned.
function redact(text) {
  return String(text ?? "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_KEY]")
    .replace(/"private_key"\s*:\s*"[^"]*"/g, '"private_key":"[REDACTED]"')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED_TOKEN]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|key|token|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/[\w.-]+@[\w-]+\.iam\.gserviceaccount\.com/g, "[service-account]");
}

module.exports = { encrypt, decrypt, redact, isConfigured, VaultError };
