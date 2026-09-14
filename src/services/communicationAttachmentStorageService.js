// src/services/communicationAttachmentStorageService.js
//
// Dedicated storage layer for Communication message file attachments.
// Mirrors communicationVoiceStorageService.js's pattern deliberately:
// storageProvider is always "local" for now, but every caller only ever
// talks to this service's methods (never fs directly), so a later move
// to S3/object storage is a change inside this one file.
//
// This is intentionally separate from the DMS document storage
// (documentService.js) — chat attachments are not official DMS
// documents and follow their own retention/access rules, same rationale
// as voice messages.

const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { ATTACHMENT_CONFIG } = require("../constants/communicationConstants");

/** Best-effort original extension, sanitized: lowercase, alnum only,
 * capped length. Never trusted for anything except a friendlier stored
 * filename suffix — the actual generated filename is always
 * server-random (see save()). */
function safeExtension(originalName) {
  const ext = path.extname(originalName || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  return ext.slice(0, 10);
}

/** Maps a MIME type to the display category the frontend uses to pick a
 * file-card icon/preview. Best-effort/display-only — never an access
 * control decision. */
function categoryForMime(mimeType) {
  const m = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (m.startsWith("image/")) return "IMAGE";
  if (m === "application/pdf") return "PDF";
  if (m === "application/msword" || m.includes("wordprocessingml")) return "WORD";
  if (m === "application/vnd.ms-excel" || m.includes("spreadsheetml")) return "EXCEL";
  if (m === "application/vnd.ms-powerpoint" || m.includes("presentationml")) return "POWERPOINT";
  if (m === "text/plain" || m === "text/csv") return "TEXT";
  if (m.includes("zip") || m.includes("rar") || m.includes("7z")) return "ARCHIVE";
  if (m.startsWith("audio/")) return "AUDIO";
  if (m.startsWith("video/")) return "VIDEO";
  return "OTHER";
}

class CommunicationAttachmentStorageService {
  static categoryForMime = categoryForMime;

  /** Validates a file upload against configured limits and the MIME/
   * extension allow-list. Throws a descriptive Error (safe to return to
   * the client) on any violation. Never trusts the client-reported MIME
   * type alone — also blocks known-dangerous extensions outright. */
  static validate({ originalName, mimeType, sizeBytes }) {
    if (!sizeBytes || sizeBytes <= 0) {
      throw new Error(`Empty file: ${originalName || "unknown"}`);
    }
    if (sizeBytes > ATTACHMENT_CONFIG.maxFileSizeBytes) {
      throw new Error(
        `"${originalName}" exceeds the maximum file size of ${Math.floor(
          ATTACHMENT_CONFIG.maxFileSizeBytes / (1024 * 1024)
        )} MB`
      );
    }

    const ext = safeExtension(originalName);
    if (ATTACHMENT_CONFIG.blockedExtensions.includes(ext)) {
      throw new Error(`"${originalName}" has a file type that is not allowed`);
    }

    const normalizedMime = (mimeType || "").split(";")[0].trim().toLowerCase();
    const isAllowed = ATTACHMENT_CONFIG.allowedMimeTypes.some(
      (m) => m.toLowerCase() === normalizedMime
    );
    if (!isAllowed) {
      throw new Error(`"${originalName}" has an unsupported file type (${mimeType || "unknown"})`);
    }
  }

  /** Persists the buffer under a safe, server-generated path and returns
   * an opaque storageKey — never a raw filesystem path, never derived
   * from the client-supplied filename (prevents path traversal). */
  static async save({ tenantId, conversationId, buffer, originalName }) {
    const safeTenantId = Number(tenantId);
    const safeConversationId = Number(conversationId);
    if (!Number.isInteger(safeTenantId) || !Number.isInteger(safeConversationId)) {
      throw new Error("Invalid storage scope");
    }

    const dir = path.join(
      process.cwd(),
      ATTACHMENT_CONFIG.storagePath,
      String(safeTenantId),
      String(safeConversationId)
    );
    await fsPromises.mkdir(dir, { recursive: true });

    const ext = safeExtension(originalName);
    const generatedName = `${Date.now()}-${crypto.randomBytes(12).toString("hex")}${ext}`;
    const fullPath = path.join(dir, generatedName);

    // Defense in depth: resolved path must still live inside `dir`.
    if (!path.resolve(fullPath).startsWith(path.resolve(dir) + path.sep)) {
      throw new Error("Invalid storage path");
    }

    await fsPromises.writeFile(fullPath, buffer);

    // Opaque key: tenant/conversation/filename — resolved back to a real
    // path only by this service, never exposed to the client directly.
    return `${safeTenantId}/${safeConversationId}/${generatedName}`;
  }

  /** Resolves a storageKey back to bytes for an authenticated, membership
   * -verified download. Callers (the controller) are responsible for all
   * access-control checks BEFORE calling this. */
  static async read(storageKey) {
    const fullPath = path.join(process.cwd(), ATTACHMENT_CONFIG.storagePath, storageKey);
    const baseDir = path.resolve(process.cwd(), ATTACHMENT_CONFIG.storagePath);
    if (!path.resolve(fullPath).startsWith(baseDir + path.sep)) {
      throw new Error("Invalid storage key");
    }
    if (!fs.existsSync(fullPath)) {
      throw new Error("Attachment file not found");
    }
    return fsPromises.readFile(fullPath);
  }

  /** Best-effort delete — used only if a message create fails partway
   * through a multi-file upload and already-saved files need cleanup. */
  static async remove(storageKey) {
    try {
      const fullPath = path.join(process.cwd(), ATTACHMENT_CONFIG.storagePath, storageKey);
      const baseDir = path.resolve(process.cwd(), ATTACHMENT_CONFIG.storagePath);
      if (!path.resolve(fullPath).startsWith(baseDir + path.sep)) return;
      await fsPromises.unlink(fullPath);
    } catch {
      // Best-effort only — a stray orphaned file is not worth failing the request over.
    }
  }
}

module.exports = CommunicationAttachmentStorageService;
