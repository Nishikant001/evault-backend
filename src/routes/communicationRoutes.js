// src/routes/communicationRoutes.js
//
// Dedicated route namespace: /api/communication — never under /api/ai/chat
// (project brief §33). Every route requires the existing auth middleware;
// there is no separate authentication mechanism for this module.

const express = require("express");
const multer = require("multer");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { requireTenantModule } = require("../middleware/tenantModuleMiddleware");
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
router.get("/users", auth, requireTenantModule("communication"), CommunicationController.searchUsers);

// ── Conversations ────────────────────────────────────────────────
router.get("/conversations", auth, requireTenantModule("communication"), CommunicationController.listConversations);
router.post("/conversations", auth, requireTenantModule("communication"), CommunicationController.createConversation);
router.post("/conversations/group", auth, requireTenantModule("communication"), CommunicationController.createGroup);
router.get("/conversations/:id", auth, requireTenantModule("communication"), CommunicationController.getConversation);
router.patch("/conversations/:id", auth, requireTenantModule("communication"), CommunicationController.renameGroup);
router.post("/conversations/:id/participants", auth, requireTenantModule("communication"), CommunicationController.addParticipants);
router.delete("/conversations/:id/participants/:userId", auth, requireTenantModule("communication"), CommunicationController.removeParticipant);

// ── Messages ─────────────────────────────────────────────────────
router.get("/conversations/:id/messages", auth, requireTenantModule("communication"), CommunicationController.listMessages);
router.post("/conversations/:id/messages", auth, requireTenantModule("communication"), CommunicationController.sendMessage);
router.post("/conversations/:id/read", auth, requireTenantModule("communication"), CommunicationController.markRead);
router.patch("/messages/:id", auth, requireTenantModule("communication"), CommunicationController.editMessage);
router.delete("/messages/:id", auth, requireTenantModule("communication"), CommunicationController.deleteMessage);

// ── Voice ────────────────────────────────────────────────────────
router.post(
  "/conversations/:id/voice",
  auth,
  requireTenantModule("communication"),
  voiceUpload.single("voice"),
  CommunicationController.sendVoiceMessage
);
router.get("/voice/:id", auth, requireTenantModule("communication"), CommunicationController.streamVoice);

// ── Attachments ──────────────────────────────────────────────────
router.post(
  "/conversations/:id/attachments",
  auth,
  requireTenantModule("communication"),
  attachmentUpload.array("files", ATTACHMENT_CONFIG.maxFilesPerMessage),
  CommunicationController.sendAttachmentMessage
);
router.get("/attachments/:id/download", auth, requireTenantModule("communication"), CommunicationController.downloadAttachment);

module.exports = router;
