// src/controllers/chatController.js
const chatService = require("../services/chatService");
const PromptHistory = require("../models/PromptHistory");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");

const createSession = async (req, res) => {
  try {
    const { title, scopeType, scopeDocumentIds, scopeFolderJson } = req.body;
    const session = await chatService.createSession({
      tenantId: req.user.tenantId,
      userId: req.user.id,
      title,
      scopeType,
      scopeDocumentIds,
      scopeFolderJson,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.AI_ASSISTANT,
      action: AUDIT_ACTIONS.CHAT_SESSION_CREATED,
      newValue: { id: session.id, scopeType: session.scopeType },
      remarks: "Started a new AI chat session",
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.status(201).json({ success: true, data: session });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const listSessions = async (req, res) => {
  try {
    const sessions = await chatService.listSessions({ tenantId: req.user.tenantId, userId: req.user.id });
    return res.json({ success: true, data: sessions });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const getMessages = async (req, res) => {
  try {
    const messages = await chatService.getMessages(req.params.sessionId, req.user.tenantId);
    return res.json({ success: true, data: messages });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const sendMessage = async (req, res) => {
  try {
    const { message, topK } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: "message is required" });
    }

    const result = await chatService.sendMessage({
      sessionId: req.params.sessionId,
      tenantId: req.user.tenantId,
      userId: req.user.id,
      message: message.trim(),
      topK,
    });

    await AuditService.log({
      req,
      module: AUDIT_MODULES.AI_ASSISTANT,
      action: AUDIT_ACTIONS.CHAT_MESSAGE_SENT,
      newValue: { sessionId: req.params.sessionId, confidenceScore: result.confidenceScore },
      remarks: "Sent a chat message to the AI Document Assistant",
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    await AuditService.log({
      req,
      module: AUDIT_MODULES.AI_ASSISTANT,
      action: AUDIT_ACTIONS.CHAT_MESSAGE_FAILED,
      newValue: { sessionId: req.params.sessionId },
      remarks: error.message,
      status: AUDIT_STATUS.FAILED,
    }).catch(() => {});

    return res.status(error.statusCode || 500).json({ success: false, message: error.message, data: error.chatMessage || null });
  }
};

const deleteSession = async (req, res) => {
  try {
    const result = await chatService.deleteSession(req.params.sessionId, req.user.tenantId);

    await AuditService.log({
      req,
      module: AUDIT_MODULES.AI_ASSISTANT,
      action: AUDIT_ACTIONS.CHAT_SESSION_DELETED,
      newValue: result,
      remarks: `Deleted chat session #${result.id}`,
      status: AUDIT_STATUS.SUCCESS,
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// Flat AI usage/audit log across every AI feature (chat + document AI),
// separate from the conversational session view above.
const listChatHistory = async (req, res) => {
  try {
    const { feature, page = 1, pageSize = 25 } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (feature) where.feature = feature;

    const { rows, count } = await PromptHistory.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: Number(pageSize),
      offset: (Number(page) - 1) * Number(pageSize),
    });

    return res.json({ success: true, data: rows, pagination: { page: Number(page), pageSize: Number(pageSize), total: count } });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

module.exports = { createSession, listSessions, getMessages, sendMessage, deleteSession, listChatHistory };
