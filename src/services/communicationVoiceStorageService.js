// src/services/communicationVoiceStorageService.js
//
// Dedicated storage layer for Communication voice messages. Intentionally
// separate from the DMS document storage logic (documentService.js /
// localFinalizationService.js) — voice notes are not official DMS
// documents (project brief §14).
//
// storageProvider is always written as "local" for now, but every caller
// only ever talks to this service's methods (never fs directly), so a
// later move to S3/object storage is a change inside this one file.

const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { VOICE_CONFIG } = require("../constants/communicationConstants");

function extensionForMime(mimeType) {
  const base = (mimeType || "").split(";")[0].trim().toLowerCase();
  const map = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
  };
  return map[base] || "audio";
}

class CommunicationVoiceStorageService {
  /** Validates a browser-recorded voice upload against the configured
   * limits. Never trusts the original filename. Throws a descriptive
   * Error (message safe to return to the client) on any violation. */
  static validate({ mimeType, sizeBytes, durationSeconds }) {
    const allowed = VOICE_CONFIG.allowedMimeTypes;
    const normalizedMime = (mimeType || "").split(";")[0].trim().toLowerCase();
    const isAllowed = allowed.some(
      (m) => m.toLowerCase() === (mimeType || "").toLowerCase() || m.toLowerCase() === normalizedMime
    );
    if (!isAllowed) {
      throw new Error(`Unsupported audio format: ${mimeType || "unknown"}`);
    }
    if (!sizeBytes || sizeBytes <= 0) {
      throw new Error("Empty voice recording");
    }
    if (sizeBytes > VOICE_CONFIG.maxSizeBytes) {
      throw new Error(
        `Voice message exceeds maximum size of ${Math.floor(VOICE_CONFIG.maxSizeBytes / (1024 * 1024))} MB`
      );
    }
    if (durationSeconds !== undefined && durationSeconds !== null) {
      if (durationSeconds <= 0) {
        throw new Error("Invalid voice message duration");
      }
      if (durationSeconds > VOICE_CONFIG.maxDurationSeconds) {
        throw new Error(
          `Voice message exceeds maximum duration of ${VOICE_CONFIG.maxDurationSeconds} seconds`
        );
      }
    }
  }

  /** Persists the buffer under a safe, server-generated path and returns
   * an opaque storageKey — never a raw filesystem path, never derived
   * from the client-supplied filename (prevents path traversal). */
  static async save({ tenantId, conversationId, buffer, mimeType }) {
    const safeTenantId = Number(tenantId);
    const safeConversationId = Number(conversationId);
    if (!Number.isInteger(safeTenantId) || !Number.isInteger(safeConversationId)) {
      throw new Error("Invalid storage scope");
    }

    const dir = path.join(
      process.cwd(),
      VOICE_CONFIG.storagePath,
      String(safeTenantId),
      String(safeConversationId)
    );
    await fsPromises.mkdir(dir, { recursive: true });

    const generatedName = `${Date.now()}-${crypto.randomBytes(12).toString("hex")}.${extensionForMime(mimeType)}`;
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
    const fullPath = path.join(process.cwd(), VOICE_CONFIG.storagePath, storageKey);
    const baseDir = path.resolve(process.cwd(), VOICE_CONFIG.storagePath);
    if (!path.resolve(fullPath).startsWith(baseDir + path.sep)) {
      throw new Error("Invalid storage key");
    }
    if (!fs.existsSync(fullPath)) {
      throw new Error("Voice file not found");
    }
    return fsPromises.readFile(fullPath);
  }
}

module.exports = CommunicationVoiceStorageService;
