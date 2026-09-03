// src/routes/chatRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const { loadSubscription, requireFeature } = require("../middleware/subscriptionMiddleware"); // NEW (Subscription Management System)
const { FEATURE_KEYS } = require("../constants/subscriptionConstants");
const {
  createSession,
  listSessions,
  getMessages,
  sendMessage,
  deleteSession,
  listChatHistory,
} = require("../controllers/chatController");

const ALL_ROLES = ["SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Uploader", "Viewer", "Auditor", "Approver"];

// RAG chat is gated on the more specific AI_CHAT flag (a plan could in
// theory enable AI_ASSISTANT features without chat, or vice versa).
router.use(auth, loadSubscription, requireFeature(FEATURE_KEYS.AI_CHAT));

// POST   /api/ai/chat/sessions               → start a session (scopeType=ALL|DOCUMENT|DOCUMENT_SET|FOLDER)
// GET    /api/ai/chat/sessions                → list my sessions
// GET    /api/ai/chat/sessions/:sessionId/messages → conversation history
// POST   /api/ai/chat/sessions/:sessionId/messages → ask a question (RAG turn)
// DELETE /api/ai/chat/sessions/:sessionId     → delete a session
router.post("/sessions", role(...ALL_ROLES), createSession);
router.get("/sessions", role(...ALL_ROLES), listSessions);
router.get("/sessions/:sessionId/messages", role(...ALL_ROLES), getMessages);
router.post("/sessions/:sessionId/messages", role(...ALL_ROLES), sendMessage);
router.delete("/sessions/:sessionId", role(...ALL_ROLES), deleteSession);

// GET /api/ai/chat/history → flat prompt/usage audit log across all AI features
router.get("/history", role("SuperAdmin", "TenantAdmin", "Auditor"), listChatHistory);

module.exports = router;
