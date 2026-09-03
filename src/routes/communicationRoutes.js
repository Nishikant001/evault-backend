// src/routes/communicationRoutes.js
//
// Dedicated route namespace: /api/communication — never under /api/ai/chat
// (project brief §33). Every route requires the existing auth middleware;
// there is no separate authentication mechanism for this module.

const express = require("express");
const multer = require("multer");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const CommunicationController = require("../controllers/communicationController");
const { VOICE_CONFIG, ATTACHMENT_CONFIG } = require("../constants/communicationConstants");

// Voice uploads: kept in memory (never trust/write directly from a raw
// request stream) and bounded by the env-configured max size, mirroring
// the pattern documentRoutes.js already uses for document uploads.
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VOICE_CONFIG.maxSizeBytes },
});

// Attachment uploads: same in-memory pattern, bounded per-file by the
// env-configured max size and capped in file count per message.
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: ATTACHMENT_CONFIG.maxFileSizeBytes,
    files: ATTACHMENT_CONFIG.maxFilesPerMessage,
  },
});

// ── Users ────────────────────────────────────────────────────────
// GET /api/communication/users?q=rahul — tenant-scoped search
router.get("/users", auth, CommunicationController.searchUsers);

// ── Conversations ────────────────────────────────────────────────
router.get("/conversations", auth, CommunicationController.listConversations);
router.post("/conversations", auth, CommunicationController.createConversation);
router.post("/conversations/group", auth, CommunicationController.createGroup);
router.get("/conversations/:id", auth, CommunicationController.getConversation);
router.patch("/conversations/:id", auth, CommunicationController.renameGroup);
router.post("/conversations/:id/participants", auth, CommunicationController.addParticipants);
router.delete("/conversations/:id/participants/:userId", auth, CommunicationController.removeParticipant);

// ── Messages ─────────────────────────────────────────────────────
router.get("/conversations/:id/messages", auth, CommunicationController.listMessages);
router.post("/conversations/:id/messages", auth, CommunicationController.sendMessage);
router.post("/conversations/:id/read", auth, CommunicationController.markRead);
router.patch("/messages/:id", auth, CommunicationController.editMessage);
router.delete("/messages/:id", auth, CommunicationController.deleteMessage);

// ── Voice ────────────────────────────────────────────────────────
router.post(
  "/conversations/:id/voice",
  auth,
  voiceUpload.single("voice"),
  CommunicationController.sendVoiceMessage
);
router.get("/voice/:id", auth, CommunicationController.streamVoice);

// ── Attachments ──────────────────────────────────────────────────
router.post(
  "/conversations/:id/attachments",
  auth,
  attachmentUpload.array("files", ATTACHMENT_CONFIG.maxFilesPerMessage),
  CommunicationController.sendAttachmentMessage
);
router.get("/attachments/:id/download", auth, CommunicationController.downloadAttachment);

module.exports = router;
