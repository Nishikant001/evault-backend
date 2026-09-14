// src/controllers/communicationController.js
//
// REST layer for the Internal Communication Module. Every handler:
//   1. reads tenantId/userId ONLY from req.user (never req.body/req.query)
//   2. uses req.models — the tenant-scoped model set resolved by
//      tenantResolverMiddleware for this request — never a shared/global
//      model singleton (MERGE — see communicationService.js header)
//   3. delegates access/business rules to communicationService
//   4. writes to the DB (source of truth) BEFORE emitting any Socket.IO event
//   5. audits meaningful actions only (never per-request noise)

const CommunicationService = require("../services/communicationService");
const CommunicationVoiceStorageService = require("../services/communicationVoiceStorageService");
const CommunicationAttachmentStorageService = require("../services/communicationAttachmentStorageService");
const CommunicationSocket = require("../services/communicationSocketService");
const NotificationCenterService = require("../services/notificationCenterService");
const AuditService = require("../services/auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const { SOCKET_EVENTS, MESSAGE_TYPES } = require("../constants/communicationConstants");

function handleError(res, error) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    console.log("Communication error:", error.message);
  }
  return res.status(statusCode).json({ success: false, message: error.message || "Something went wrong" });
}

/** Notifies the recipient of a new message: real-time via Socket.IO
 * always, plus a persistent in-app Notification when they're not
 * actively online. `models` is the SENDER's tenant-scoped model set —
 * always correct here since sender and recipient are always the same
 * tenant (enforced by CommunicationService.verifyParticipant before this
 * is ever called). */
async function notifyRecipient({ models, tenantId, recipientId, senderName, conversationId, message }) {
  CommunicationSocket.emitToUser(recipientId, SOCKET_EVENTS.MESSAGE_NEW, { conversationId, message });

  if (!CommunicationSocket.isUserOnline(tenantId, recipientId)) {
    try {
      await NotificationCenterService.create(models, {
        tenantId,
        userId: recipientId,
        type: "COMMUNICATION_MESSAGE",
        title: `New message from ${senderName}`,
        message:
          message.messageType === MESSAGE_TYPES.VOICE
            ? "Sent you a voice message"
            : message.messageType === MESSAGE_TYPES.FILE
            ? message.attachments?.length === 1
              ? `Sent a file: ${message.attachments[0].originalName}`
              : `Sent ${message.attachments?.length || "a"} file(s)`
            : (message.content || "").slice(0, 140),
      });
    } catch (error) {
      // Notification failures must never break message delivery.
      console.log("Communication notification error:", error.message);
    }
  }
}

/** Fan-out for GROUP conversations (N recipients) as well as DIRECT
 * (1 recipient) — every message-send handler should use this instead of
 * assuming a single other participant. */
async function notifyRecipients({ models, tenantId, recipientIds, senderName, conversationId, message }) {
  for (const recipientId of recipientIds) {
    await notifyRecipient({ models, tenantId, recipientId, senderName, conversationId, message });
  }
}

class CommunicationController {
  // ── Users ────────────────────────────────────────────────────────
  static async searchUsers(req, res) {
    try {
      const { q = "" } = req.query;
      const users = await CommunicationService.searchUsers(req.models, req.masterModels, req.user.tenantId, req.user.id, q);
      return res.json({ success: true, data: users });
    } catch (error) {
      return handleError(res, error);
    }
  }

  // ── Conversations ────────────────────────────────────────────────
  static async listConversations(req, res) {
    try {
      const { search = "" } = req.query;
      const conversations = await CommunicationService.listConversations(
        req.models,
        req.masterModels,
        req.user.tenantId,
        req.user.id,
        { search }
      );
      return res.json({ success: true, data: conversations });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async createConversation(req, res) {
    try {
      const { userId: targetUserId } = req.body;
      const { conversation, created } = await CommunicationService.findOrCreateConversation(
        req.models,
        req.user.tenantId,
        req.user.id,
        targetUserId
      );

      if (created) {
        await AuditService.log({
          req,
          module: AUDIT_MODULES.COMMUNICATION,
          action: AUDIT_ACTIONS.COMMUNICATION_CONVERSATION_CREATED,
          remarks: `Started conversation ${conversation.id} with user ${targetUserId}`,
          status: AUDIT_STATUS.SUCCESS,
        });

        const otherId = await CommunicationService.getOtherParticipantId(conversation, req.user.id);
        CommunicationSocket.emitToUser(otherId, SOCKET_EVENTS.CONVERSATION_CREATED, {
          conversationId: conversation.id,
        });
      }

      return res.status(created ? 201 : 200).json({ success: true, data: { conversationId: conversation.id, created } });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async getConversation(req, res) {
    try {
      const { conversation } = await CommunicationService.verifyParticipant(
        req.models,
        req.user.tenantId,
        req.user.id,
        req.params.id
      );

      if (conversation.type === "GROUP") {
        const members = await CommunicationService.getActiveParticipants(req.models, req.user.tenantId, conversation.id);
        return res.json({
          success: true,
          data: {
            conversationId: conversation.id,
            type: "GROUP",
            name: conversation.name,
            isAdmin: conversation.createdBy === req.user.id,
            members: members.map((m) => ({
              id: m.id,
              name: m.name,
              email: m.email,
              online: CommunicationSocket.isUserOnline(req.user.tenantId, m.id),
            })),
            lastMessageAt: conversation.lastMessageAt,
          },
        });
      }

      const otherId = await CommunicationService.getOtherParticipantId(conversation, req.user.id);
      return res.json({
        success: true,
        data: {
          conversationId: conversation.id,
          type: "DIRECT",
          otherUserId: otherId,
          lastMessageAt: conversation.lastMessageAt,
          isOtherUserOnline: CommunicationSocket.isUserOnline(req.user.tenantId, otherId),
        },
      });
    } catch (error) {
      return handleError(res, error);
    }
  }

  // ── Group conversations ─────────────────────────────────────────
  static async createGroup(req, res) {
    try {
      const { name, participantIds = [] } = req.body;
      const conversation = await CommunicationService.createGroupConversation(req.models, req.user.tenantId, req.user.id, {
        name,
        participantIds,
      });

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_CONVERSATION_CREATED,
        remarks: `Created group conversation ${conversation.id} ("${conversation.name}")`,
        status: AUDIT_STATUS.SUCCESS,
      });

      const memberIds = await CommunicationService.getOtherParticipantIds(
        req.models,
        req.user.tenantId,
        conversation,
        req.user.id
      );
      for (const memberId of memberIds) {
        CommunicationSocket.emitToUser(memberId, SOCKET_EVENTS.CONVERSATION_CREATED, { conversationId: conversation.id });
      }

      return res.status(201).json({ success: true, data: { conversationId: conversation.id } });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async addParticipants(req, res) {
    try {
      const { userIds = [] } = req.body;
      const members = await CommunicationService.addParticipants(
        req.models,
        req.user.tenantId,
        req.user.id,
        req.params.id,
        userIds
      );

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_CONVERSATION_UPDATED,
        remarks: `Added ${userIds.length} member(s) to group conversation ${req.params.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      CommunicationSocket.emitToConversation(req.params.id, SOCKET_EVENTS.CONVERSATION_UPDATED, {
        conversationId: Number(req.params.id),
      });
      for (const id of userIds) {
        CommunicationSocket.emitToUser(id, SOCKET_EVENTS.CONVERSATION_CREATED, { conversationId: Number(req.params.id) });
      }

      return res.json({ success: true, data: members.map((m) => ({ id: m.id, name: m.name, email: m.email })) });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async removeParticipant(req, res) {
    try {
      const targetUserId = req.params.userId === "me" ? req.user.id : Number(req.params.userId);
      await CommunicationService.removeParticipant(req.models, req.user.tenantId, req.user.id, req.params.id, targetUserId);

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_CONVERSATION_UPDATED,
        remarks:
          targetUserId === req.user.id
            ? `Left group conversation ${req.params.id}`
            : `Removed member ${targetUserId} from group conversation ${req.params.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      CommunicationSocket.emitToConversation(req.params.id, SOCKET_EVENTS.CONVERSATION_UPDATED, {
        conversationId: Number(req.params.id),
      });
      CommunicationSocket.emitToUser(targetUserId, SOCKET_EVENTS.CONVERSATION_UPDATED, {
        conversationId: Number(req.params.id),
        removed: true,
      });

      return res.json({ success: true });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async renameGroup(req, res) {
    try {
      const { name } = req.body;
      const conversation = await CommunicationService.renameGroup(req.models, req.user.tenantId, req.user.id, req.params.id, name);

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_CONVERSATION_UPDATED,
        remarks: `Renamed group conversation ${req.params.id} to "${conversation.name}"`,
        status: AUDIT_STATUS.SUCCESS,
      });

      CommunicationSocket.emitToConversation(req.params.id, SOCKET_EVENTS.CONVERSATION_UPDATED, {
        conversationId: Number(req.params.id),
        name: conversation.name,
      });

      return res.json({ success: true, data: { name: conversation.name } });
    } catch (error) {
      return handleError(res, error);
    }
  }

  // ── Messages ─────────────────────────────────────────────────────
  static async listMessages(req, res) {
    try {
      const { beforeId, limit } = req.query;
      const messages = await CommunicationService.listMessages(req.models, req.user.tenantId, req.user.id, req.params.id, {
        beforeId,
        limit,
      });
      return res.json({ success: true, data: messages });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async sendMessage(req, res) {
    try {
      const { content, replyToMessageId } = req.body;
      const message = await CommunicationService.sendTextMessage(
        req.models,
        req.user.tenantId,
        req.user.id,
        req.params.id,
        { content, replyToMessageId }
      );

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_MESSAGE_SENT,
        remarks: `Sent message ${message.id} in conversation ${req.params.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      const membership = await CommunicationService.verifyParticipant(req.models, req.user.tenantId, req.user.id, req.params.id);
      const recipientIds = await CommunicationService.getOtherParticipantIds(
        req.models,
        req.user.tenantId,
        membership.conversation,
        req.user.id
      );

      CommunicationSocket.emitToConversation(req.params.id, SOCKET_EVENTS.MESSAGE_SENT, { message });
      await notifyRecipients({
        models: req.models,
        tenantId: req.user.tenantId,
        recipientIds,
        senderName: req.user.email,
        conversationId: Number(req.params.id),
        message,
      });

      return res.status(201).json({ success: true, data: message });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async editMessage(req, res) {
    try {
      const { content } = req.body;
      const message = await CommunicationService.editMessage(req.models, req.user.tenantId, req.user.id, req.params.id, content);

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_MESSAGE_EDITED,
        remarks: `Edited message ${req.params.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      CommunicationSocket.emitToConversation(message.conversationId, SOCKET_EVENTS.MESSAGE_EDITED, { message });

      return res.json({ success: true, data: message });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async deleteMessage(req, res) {
    try {
      const message = await CommunicationService.deleteMessage(req.models, req.user.tenantId, req.user.id, req.params.id);

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_MESSAGE_DELETED,
        remarks: `Deleted message ${req.params.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      CommunicationSocket.emitToConversation(message.conversationId, SOCKET_EVENTS.MESSAGE_DELETED, { message });

      return res.json({ success: true, data: message });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async markRead(req, res) {
    try {
      const result = await CommunicationService.markConversationRead(req.models, req.user.tenantId, req.user.id, req.params.id);

      // Note: read receipts are business-meaningful but high-frequency;
      // audited at INFO-equivalent granularity only when explicitly
      // requested by compliance needs. Kept out by default to avoid
      // flooding AuditLog — enable by uncommenting if required.
      // await AuditService.log({ req, module: AUDIT_MODULES.COMMUNICATION,
      //   action: AUDIT_ACTIONS.COMMUNICATION_MESSAGE_READ,
      //   remarks: `Marked conversation ${req.params.id} read`, status: AUDIT_STATUS.SUCCESS });

      CommunicationSocket.emitToConversation(req.params.id, SOCKET_EVENTS.MESSAGE_READ, {
        conversationId: Number(req.params.id),
        userId: req.user.id,
        lastReadMessageId: result.lastReadMessageId,
      });

      return res.json({ success: true, data: result });
    } catch (error) {
      return handleError(res, error);
    }
  }

  // ── Voice ────────────────────────────────────────────────────────
  static async sendVoiceMessage(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: "Voice recording is required" });
      }

      const durationSeconds = Number(req.body.durationSeconds);
      CommunicationVoiceStorageService.validate({
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        durationSeconds,
      });

      const storageKey = await CommunicationVoiceStorageService.save({
        tenantId: req.user.tenantId,
        conversationId: req.params.id,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
      });

      const message = await CommunicationService.sendVoiceMessage(req.models, req.user.tenantId, req.user.id, req.params.id, {
        storageKey,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        durationSeconds,
        replyToMessageId: req.body.replyToMessageId,
      });

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_VOICE_MESSAGE_SENT,
        remarks: `Sent voice message ${message.id} (${durationSeconds}s) in conversation ${req.params.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      const membership = await CommunicationService.verifyParticipant(req.models, req.user.tenantId, req.user.id, req.params.id);
      const recipientIds = await CommunicationService.getOtherParticipantIds(
        req.models,
        req.user.tenantId,
        membership.conversation,
        req.user.id
      );

      CommunicationSocket.emitToConversation(req.params.id, SOCKET_EVENTS.MESSAGE_SENT, { message });
      await notifyRecipients({
        models: req.models,
        tenantId: req.user.tenantId,
        recipientIds,
        senderName: req.user.email,
        conversationId: Number(req.params.id),
        message,
      });

      return res.status(201).json({ success: true, data: message });
    } catch (error) {
      return handleError(res, error);
    }
  }

  /** Authenticated, membership-verified voice file streaming. Never
   * exposes a raw filesystem path — resolves storageKey server-side only. */
  static async streamVoice(req, res) {
    try {
      const { CommunicationVoiceMessage, CommunicationMessage } = req.models;
      const voice = await CommunicationVoiceMessage.findOne({
        where: { id: req.params.id, tenantId: req.user.tenantId },
      });
      if (!voice) return res.status(404).json({ success: false, message: "Voice message not found" });

      const message = await CommunicationMessage.findOne({
        where: { id: voice.messageId, tenantId: req.user.tenantId },
      });
      if (!message) return res.status(404).json({ success: false, message: "Voice message not found" });

      // Access control: must be a verified participant of the parent
      // conversation — this is what stops IDOR on /voice/:id.
      await CommunicationService.verifyParticipant(req.models, req.user.tenantId, req.user.id, message.conversationId);

      const buffer = await CommunicationVoiceStorageService.read(voice.storageKey);

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_VOICE_MESSAGE_PLAYED,
        remarks: `Played voice message ${voice.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      res.setHeader("Content-Type", voice.mimeType);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.send(buffer);
    } catch (error) {
      return handleError(res, error);
    }
  }

  // ── Attachments ──────────────────────────────────────────────────
  /** Accepts one or more files (multipart) plus optional text, validates
   * + persists each to storage, then creates a single message carrying
   * all of them. Any file failing validation aborts the whole request
   * (nothing partially attached) and already-saved files are cleaned up. */
  static async sendAttachmentMessage(req, res) {
    const savedKeys = [];
    try {
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ success: false, message: "At least one file is required" });
      }

      // Validate every file up front before saving any of them.
      for (const file of files) {
        CommunicationAttachmentStorageService.validate({
          originalName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
        });
      }

      const attachments = [];
      for (const file of files) {
        const storageKey = await CommunicationAttachmentStorageService.save({
          tenantId: req.user.tenantId,
          conversationId: req.params.id,
          buffer: file.buffer,
          originalName: file.originalname,
        });
        savedKeys.push(storageKey);
        attachments.push({
          storageKey,
          originalName: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
          fileCategory: CommunicationAttachmentStorageService.categoryForMime(file.mimetype),
        });
      }

      const message = await CommunicationService.sendAttachmentMessage(
        req.models,
        req.user.tenantId,
        req.user.id,
        req.params.id,
        { content: req.body.content, replyToMessageId: req.body.replyToMessageId, attachments }
      );

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_ATTACHMENT_SENT,
        remarks: `Sent message ${message.id} with ${attachments.length} attachment(s) in conversation ${req.params.id}`,
        status: AUDIT_STATUS.SUCCESS,
      });

      const membership = await CommunicationService.verifyParticipant(req.models, req.user.tenantId, req.user.id, req.params.id);
      const recipientIds = await CommunicationService.getOtherParticipantIds(
        req.models,
        req.user.tenantId,
        membership.conversation,
        req.user.id
      );

      CommunicationSocket.emitToConversation(req.params.id, SOCKET_EVENTS.MESSAGE_SENT, { message });
      await notifyRecipients({
        models: req.models,
        tenantId: req.user.tenantId,
        recipientIds,
        senderName: req.user.email,
        conversationId: Number(req.params.id),
        message,
      });

      return res.status(201).json({ success: true, data: message });
    } catch (error) {
      // Best-effort cleanup of anything already written to disk this request.
      for (const key of savedKeys) {
        await CommunicationAttachmentStorageService.remove(key);
      }
      return handleError(res, error);
    }
  }

  /** Authenticated, membership-verified attachment download. Never
   * exposes a raw filesystem path — resolves storageKey server-side only. */
  static async downloadAttachment(req, res) {
    try {
      const { CommunicationAttachment, CommunicationMessage } = req.models;
      const attachment = await CommunicationAttachment.findOne({
        where: { id: req.params.id, tenantId: req.user.tenantId },
      });
      if (!attachment) return res.status(404).json({ success: false, message: "Attachment not found" });

      const message = await CommunicationMessage.findOne({
        where: { id: attachment.messageId, tenantId: req.user.tenantId },
      });
      if (!message) return res.status(404).json({ success: false, message: "Attachment not found" });

      // Access control: must be a verified participant of the parent
      // conversation — this is what stops IDOR on /attachments/:id.
      await CommunicationService.verifyParticipant(req.models, req.user.tenantId, req.user.id, message.conversationId);

      if (attachment.scanStatus === "INFECTED") {
        return res.status(403).json({ success: false, message: "This file was flagged and cannot be downloaded" });
      }

      const buffer = await CommunicationAttachmentStorageService.read(attachment.storageKey);

      await AuditService.log({
        req,
        module: AUDIT_MODULES.COMMUNICATION,
        action: AUDIT_ACTIONS.COMMUNICATION_ATTACHMENT_DOWNLOADED,
        remarks: `Downloaded attachment ${attachment.id} (${attachment.originalName})`,
        status: AUDIT_STATUS.SUCCESS,
      });

      const inline = req.query.mode === "inline" && attachment.fileCategory === "IMAGE";
      res.setHeader("Content-Type", attachment.mimeType);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(attachment.originalName)}"`
      );
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.send(buffer);
    } catch (error) {
      return handleError(res, error);
    }
  }
}

module.exports = CommunicationController;
