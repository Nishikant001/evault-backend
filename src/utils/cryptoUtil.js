// src/utils/cryptoUtil.js
//
// Symmetric encryption for secrets we must store but not display back in
// plaintext (currently: AIProvider.apiKeyEncrypted). Uses AES-256-GCM with
// a key derived from JWT_SECRET (or AI_ENCRYPTION_KEY if set) so no new
// mandatory env var is required to run the project.

const crypto = require("crypto");

function getKey() {
  const secret =
    process.env.ERP_CREDENTIAL_ENCRYPTION_KEY ||
    process.env.AI_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "fallback-dev-key";
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === "") return null;
  const iv = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

function decrypt(payload) {
  if (!payload) return null;
  try {
    const [ivHex, authTagHex, dataHex] = payload.split(":");
    if (!ivHex || !authTagHex || !dataHex) return null;
    const key = getKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch (err) {
    console.error("[cryptoUtil] Failed to decrypt payload:", err.message);
    return null;
  }
}

// Masks a secret for API responses, e.g. "sk-abc...wxyz"
function mask(plainText) {
  if (!plainText) return null;
  const str = String(plainText);
  if (str.length <= 8) return "••••••••";
  return `${str.slice(0, 4)}...${str.slice(-4)}`;
}

module.exports = { encrypt, decrypt, mask };
