// src/constants/communicationConstants.js
//
// Central vocabulary + configuration for the Internal Communication module
// (1-to-1 chat + voice messages). Kept separate from the AI Assistant
// (aiConstants.js) and every other module on purpose — see the module's
// README notes in communicationService.js for the full rationale.

const MESSAGE_TYPES = {
  TEXT: "TEXT",
  VOICE: "VOICE",
  FILE: "FILE",
  SYSTEM: "SYSTEM",
};

const CONVERSATION_TYPES = {
  DIRECT: "DIRECT",
  GROUP: "GROUP",
};

// ── Voice message configuration ─────────────────────────────────────
// Every value below is environment-driven with a safe local-dev default.
// Nothing here is a hard-coded production limit — see .env.example.
const VOICE_CONFIG = {
  get maxDurationSeconds() {
    return Number(process.env.CHAT_VOICE_MAX_DURATION_SECONDS) || 120;
  },
  get maxSizeBytes() {
    return Number(process.env.CHAT_VOICE_MAX_SIZE_BYTES) || 10 * 1024 * 1024; // 10 MB
  },
  get storagePath() {
    return process.env.CHAT_VOICE_STORAGE_PATH || "uploads/communication/voice";
  },
  get allowedMimeTypes() {
    const raw = process.env.CHAT_VOICE_ALLOWED_MIME_TYPES;
    if (raw && raw.trim()) {
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    // Safe development defaults — the common browser-recorded audio
    // formats across Chrome/Firefox/Safari MediaRecorder implementations.
    return [
      "audio/webm",
      "audio/webm;codecs=opus",
      "audio/ogg",
      "audio/ogg;codecs=opus",
      "audio/mp4",
      "audio/mpeg",
      "audio/wav",
      "audio/x-m4a",
      "audio/aac",
    ];
  },
};

// ── File attachment configuration ───────────────────────────────────
// Mirrors VOICE_CONFIG's shape/rationale: env-driven with safe local-dev
// defaults, storageProvider always "local" for now (see
// communicationAttachmentStorageService.js for the single choke point a
// later S3/object-storage move would touch).
const ATTACHMENT_CONFIG = {
  get maxFileSizeBytes() {
    return Number(process.env.CHAT_ATTACHMENT_MAX_SIZE_BYTES) || 25 * 1024 * 1024; // 25 MB
  },
  get maxFilesPerMessage() {
    return Number(process.env.CHAT_ATTACHMENT_MAX_FILES_PER_MESSAGE) || 10;
  },
  get storagePath() {
    return process.env.CHAT_ATTACHMENT_STORAGE_PATH || "uploads/communication/attachments";
  },
  // Deliberately an allow-list, not a deny-list (project brief §7): no
  // executables, scripts, or other potentially dangerous file types.
  get allowedMimeTypes() {
    const raw = process.env.CHAT_ATTACHMENT_ALLOWED_MIME_TYPES;
    if (raw && raw.trim()) {
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return [
      // Images
      "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
      // Documents
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/plain", "text/csv",
      // Archives
      "application/zip", "application/x-zip-compressed", "application/x-rar-compressed",
      "application/x-7z-compressed",
      // Audio / video (shared as files, distinct from recorded VOICE messages)
      "audio/mpeg", "audio/wav", "audio/mp4", "audio/ogg", "audio/webm",
      "video/mp4", "video/webm", "video/quicktime",
    ];
  },
  // Extensions blocked outright regardless of the (spoofable) MIME type
  // the browser reports — defense in depth against disguised executables.
  get blockedExtensions() {
    return [".exe", ".bat", ".cmd", ".sh", ".msi", ".dll", ".scr", ".com", ".js", ".vbs", ".ps1", ".jar", ".app"];
  },
};

// ── Call configuration ───────────────────────────────────────────────
const CALL_TYPES = {
  AUDIO: "AUDIO",
  VIDEO: "VIDEO",
};

const CALL_STATUS = {
  RINGING: "RINGING",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  COMPLETED: "COMPLETED",
  DECLINED: "DECLINED",
  MISSED: "MISSED",
  CANCELLED: "CANCELLED",
  BUSY: "BUSY",
  FAILED: "FAILED",
};

const CALL_CONFIG = {
  get ringTimeoutMs() {
    return Number(process.env.COMMUNICATION_CALL_RING_TIMEOUT_MS) || 30000;
  },
};

// ── Socket.IO event names ───────────────────────────────────────────
const SOCKET_EVENTS = {
  // Connection
  CONNECTED: "communication:connected",
  PRESENCE: "communication:presence",
  ERROR: "communication:error",

  // Room management (server validates membership before joining)
  JOIN_CONVERSATION: "communication:conversation:join",
  LEAVE_CONVERSATION: "communication:conversation:leave",

  // Messaging
  MESSAGE_NEW: "communication:message:new",
  MESSAGE_SENT: "communication:message:sent",
  MESSAGE_DELIVERED: "communication:message:delivered",
  MESSAGE_READ: "communication:message:read",
  MESSAGE_TYPING: "communication:message:typing",
  MESSAGE_STOP_TYPING: "communication:message:stop-typing",
  MESSAGE_EDITED: "communication:message:edited",
  MESSAGE_DELETED: "communication:message:deleted",

  // Conversation
  CONVERSATION_CREATED: "communication:conversation:created",
  CONVERSATION_UPDATED: "communication:conversation:updated",

  // Presence
  USER_ONLINE: "communication:user:online",
  USER_OFFLINE: "communication:user:offline",

  // Calling — WebRTC signalling (project brief: Phase 1 audio/video calling)
  CALL_INVITE: "communication:call:invite", // metadata only: callId, conversationId, callType, caller
  CALL_OFFER: "communication:call:offer", // SDP offer (initial + renegotiation/ICE-restart)
  CALL_ANSWER: "communication:call:answer", // SDP answer (initial + renegotiation/ICE-restart)
  CALL_ICE_CANDIDATE: "communication:call:ice-candidate",
  CALL_ACCEPT: "communication:call:accept",
  CALL_DECLINE: "communication:call:decline",
  CALL_CANCEL: "communication:call:cancel",
  CALL_BUSY: "communication:call:busy",
  CALL_END: "communication:call:end",
  CALL_TIMEOUT: "communication:call:timeout",
  CALL_ERROR: "communication:call:error",
};

// Typing indicator auto-expiry (server-side safety net in case a
// "stop-typing" event is lost, e.g. client crash/tab close).
const TYPING_TIMEOUT_MS = 6000;

module.exports = {
  MESSAGE_TYPES,
  CONVERSATION_TYPES,
  VOICE_CONFIG,
  ATTACHMENT_CONFIG,
  CALL_TYPES,
  CALL_STATUS,
  CALL_CONFIG,
  SOCKET_EVENTS,
  TYPING_TIMEOUT_MS,
};
