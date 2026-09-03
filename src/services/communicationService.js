// src/services/communicationService.js
//
// Core business logic for the Internal Communication Module (1-to-1 chat
// + voice messages). This is a completely independent domain from:
//   - the AI Document Assistant (ChatSession/ChatMessage/chatService.js)
//   - the Cross-Department Temporary Access workflow
// Nothing here touches either of those.
//
// MERGE — tenant-aware rewrite. Every method now takes `models` (the
// tenant-scoped model set from req.models / getTenantConnection(...).models)
// as its FIRST parameter, exactly like AuditService / NotificationCenterService
// elsewhere in this backend — there is no shared/global model singleton
// left anywhere in this file. `Department` is a MASTER DB model (Phase
// A/B), so the two methods that need it (_resolveDepartments,
// searchUsers, listConversations) also take `masterModels` explicitly.
//
// SECURITY INVARIANT (applies to every function below): tenantId and the
// acting userId are ALWAYS taken from the authenticated req.user context
// by the controller and passed in explicitly — never trusted from the
// request body/query. Every query below re-scopes by tenantId AND, for
// conversation/message access, by verified participant membership. This
// is what stands between this module and cross-tenant/IDOR access.

const { Op } = require("sequelize");
const { MESSAGE_TYPES, CONVERSATION_TYPES } = require("../constants/communicationConstants");
const { ASSIGNMENT_LEVELS, ASSIGNMENT_STATUS } = require("../constants/assignmentConstants");

const MESSAGE_PAGE_SIZE_DEFAULT = 40;
const MESSAGE_PAGE_SIZE_MAX = 100;

class CommunicationAccessError extends Error {
  constructor(message = "Access denied", statusCode = 403) {
    super(message);
    this.statusCode = statusCode;
  }
}

class CommunicationService {
  // ── User discovery ──────────────────────────────────────────────
  // Tenant-scoped at the DB level — the frontend never receives another
  // tenant's users under any circumstance.
  static async searchUsers(models, masterModels, tenantId, currentUserId, query = "", { limit = 20 } = {}) {
    const { User } = models;
    const where = {
      tenantId,
      isActive: true,
      id: { [Op.ne]: currentUserId },
    };
    const trimmed = (query || "").trim();
    if (trimmed) {
      where[Op.or] = [
        { name: { [Op.like]: `%${trimmed}%` } },
        { email: { [Op.like]: `%${trimmed}%` } },
      ];
    }

    const users = await User.findAll({
      where,
      attributes: ["id", "name", "email", "role", "isActive"],
      order: [["name", "ASC"]],
      limit: Math.min(limit, 50),
    });

    const departmentByUserId = await CommunicationService._resolveDepartments(
      models,
      masterModels,
      tenantId,
      users.map((u) => u.id)
    );

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      department: departmentByUserId.get(u.id) || null,
    }));
  }

  /** Best-effort department label for a set of users, derived from their
   * active DEPARTMENT-level UserAssignment rows. A user may have none
   * (unassigned) or several — the first is used for display purposes
   * only; this is organizational context, never an access boundary here.
   * UserAssignment is a TENANT model (models.UserAssignment); Department
   * is a MASTER model (masterModels.Department) — two separate lookups,
   * joined in memory, since they live on different physical connections. */
  static async _resolveDepartments(models, masterModels, tenantId, userIds) {
    const { UserAssignment } = models;
    const { Department } = masterModels;
    const result = new Map();
    if (!userIds.length) return result;

    const assignments = await UserAssignment.findAll({
      where: {
        tenantId,
        userId: userIds,
        assignmentLevel: ASSIGNMENT_LEVELS.DEPARTMENT,
        status: ASSIGNMENT_STATUS.ACTIVE,
        departmentId: { [Op.ne]: null },
      },
      attributes: ["userId", "departmentId"],
    });
    if (!assignments.length) return result;

    const departmentIds = [...new Set(assignments.map((a) => a.departmentId))];
    const departments = await Department.findAll({
      where: { id: departmentIds },
      attributes: ["id", "name"],
    });
    const nameById = new Map(departments.map((d) => [d.id, d.name]));

    for (const a of assignments) {
      if (!result.has(a.userId)) {
        result.set(a.userId, nameById.get(a.departmentId) || null);
      }
    }
    return result;
  }

  // ── Conversation creation / lookup ──────────────────────────────
  static buildParticipantPair(userIdA, userIdB) {
    return userIdA < userIdB
      ? { participantAId: userIdA, participantBId: userIdB }
      : { participantAId: userIdB, participantBId: userIdA };
  }

  /** Finds an existing DIRECT conversation between two users of the same
   * tenant, or creates one + its two CommunicationParticipant rows.
   * Enforces: target exists, target active, same tenant, no self-chat. */
  static async findOrCreateConversation(models, tenantId, currentUserId, targetUserId) {
    const { User, CommunicationConversation, CommunicationParticipant } = models;
    const targetId = Number(targetUserId);
    if (!Number.isInteger(targetId)) {
      throw new CommunicationAccessError("Invalid target user", 400);
    }
    if (targetId === currentUserId) {
      throw new CommunicationAccessError("Cannot start a conversation with yourself", 400);
    }

    const targetUser = await User.findOne({
      where: { id: targetId, tenantId, isActive: true },
    });
    if (!targetUser) {
      throw new CommunicationAccessError("User not found in your organization", 404);
    }

    const pair = CommunicationService.buildParticipantPair(currentUserId, targetId);

    const existing = await CommunicationConversation.findOne({
      where: { tenantId, ...pair },
    });
    if (existing) {
      return { conversation: existing, created: false };
    }

    const conversation = await CommunicationConversation.create({
      tenantId,
      type: "DIRECT",
      ...pair,
      createdBy: currentUserId,
    });

    await CommunicationParticipant.bulkCreate([
      { conversationId: conversation.id, tenantId, userId: currentUserId },
      { conversationId: conversation.id, tenantId, userId: targetId },
    ]);

    return { conversation, created: true };
  }

  /** Creates a GROUP conversation. `participantIds` must all belong to
   * the same tenant and be active; the creator is always included and
   * becomes the group's admin (CommunicationConversation.createdBy —
   * the only user who can rename the group or remove other members). */
  static async createGroupConversation(models, tenantId, creatorId, { name, participantIds = [] } = {}) {
    const { User, CommunicationConversation, CommunicationParticipant } = models;
    const trimmedName = (name || "").trim();
    if (!trimmedName) {
      throw new CommunicationAccessError("Group name is required", 400);
    }
    if (trimmedName.length > 120) {
      throw new CommunicationAccessError("Group name is too long", 400);
    }

    const uniqueIds = [...new Set((participantIds || []).map(Number).filter((id) => Number.isInteger(id) && id !== creatorId))];
    if (uniqueIds.length < 2) {
      throw new CommunicationAccessError("Select at least 2 other members to create a group", 400);
    }

    const members = await User.findAll({
      where: { id: uniqueIds, tenantId, isActive: true },
      attributes: ["id"],
    });
    if (members.length !== uniqueIds.length) {
      throw new CommunicationAccessError("One or more selected users were not found in your organization", 400);
    }

    const conversation = await CommunicationConversation.create({
      tenantId,
      type: CONVERSATION_TYPES.GROUP,
      name: trimmedName,
      createdBy: creatorId,
    });

    await CommunicationParticipant.bulkCreate(
      [creatorId, ...uniqueIds].map((userId) => ({ conversationId: conversation.id, tenantId, userId }))
    );

    return conversation;
  }

  /** Active (non-left) participant user rows for a GROUP conversation, or
   * the single other user for a DIRECT one — used for the chat header
   * "member list" and the add-participants picker. */
  static async getActiveParticipants(models, tenantId, conversationId) {
    const { User, CommunicationParticipant } = models;
    const rows = await CommunicationParticipant.findAll({
      where: { tenantId, conversationId, leftAt: null },
    });
    const users = await User.findAll({
      where: { id: rows.map((r) => r.userId), tenantId },
      attributes: ["id", "name", "email", "role", "isActive"],
    });
    return users;
  }

  /** Admin-only (the creator is the admin). Adds new members; silently
   * skips anyone already active in the group rather than erroring on
   * partial overlap. */
  static async addParticipants(models, tenantId, actorId, conversationId, userIds = []) {
    const { User, CommunicationParticipant } = models;
    const { conversation } = await CommunicationService.verifyParticipant(models, tenantId, actorId, conversationId);
    if (conversation.type !== CONVERSATION_TYPES.GROUP) {
      throw new CommunicationAccessError("Only group conversations support adding members", 400);
    }

    const uniqueIds = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
    if (!uniqueIds.length) throw new CommunicationAccessError("No users selected", 400);

    const validUsers = await User.findAll({ where: { id: uniqueIds, tenantId, isActive: true }, attributes: ["id"] });
    const validIds = new Set(validUsers.map((u) => u.id));

    const existing = await CommunicationParticipant.findAll({ where: { tenantId, conversationId } });
    const existingByUser = new Map(existing.map((p) => [p.userId, p]));

    const toCreate = [];
    for (const id of uniqueIds) {
      if (!validIds.has(id)) continue;
      const row = existingByUser.get(id);
      if (row && !row.leftAt) continue; // already an active member
      if (row && row.leftAt) {
        row.leftAt = null; // rejoining
        await row.save();
        continue;
      }
      toCreate.push({ conversationId, tenantId, userId: id });
    }
    if (toCreate.length) await CommunicationParticipant.bulkCreate(toCreate);

    return CommunicationService.getActiveParticipants(models, tenantId, conversationId);
  }

  /** `actorId === targetUserId` is a self-initiated "leave"; otherwise
   * only the group's creator (admin) may remove another member. */
  static async removeParticipant(models, tenantId, actorId, conversationId, targetUserId) {
    const { CommunicationParticipant } = models;
    const { conversation } = await CommunicationService.verifyParticipant(models, tenantId, actorId, conversationId);
    if (conversation.type !== CONVERSATION_TYPES.GROUP) {
      throw new CommunicationAccessError("Only group conversations support removing members", 400);
    }
    const target = Number(targetUserId);
    if (target !== actorId && conversation.createdBy !== actorId) {
      throw new CommunicationAccessError("Only the group admin can remove other members", 403);
    }

    const participant = await CommunicationParticipant.findOne({ where: { tenantId, conversationId, userId: target } });
    if (!participant || participant.leftAt) return conversation;

    participant.leftAt = new Date();
    await participant.save();
    return conversation;
  }

  static async renameGroup(models, tenantId, actorId, conversationId, name) {
    const { conversation } = await CommunicationService.verifyParticipant(models, tenantId, actorId, conversationId);
    if (conversation.type !== CONVERSATION_TYPES.GROUP) {
      throw new CommunicationAccessError("Only group conversations can be renamed", 400);
    }
    if (conversation.createdBy !== actorId) {
      throw new CommunicationAccessError("Only the group admin can rename this group", 403);
    }
    const trimmed = (name || "").trim();
    if (!trimmed) throw new CommunicationAccessError("Group name is required", 400);
    if (trimmed.length > 120) throw new CommunicationAccessError("Group name is too long", 400);

    conversation.name = trimmed;
    await conversation.save();
    return conversation;
  }

  /** Throws unless `userId` is a verified participant of `conversationId`
   * within `tenantId`. Returns the CommunicationParticipant row on
   * success — this is the single choke point every message/voice
   * operation must pass through before touching conversation data. */
  static async verifyParticipant(models, tenantId, userId, conversationId) {
    const { CommunicationConversation, CommunicationParticipant } = models;
    const conversation = await CommunicationConversation.findOne({
      where: { id: conversationId, tenantId },
    });
    if (!conversation) {
      throw new CommunicationAccessError("Conversation not found", 404);
    }
    const participant = await CommunicationParticipant.findOne({
      where: { conversationId, tenantId, userId, leftAt: null },
    });
    if (!participant) {
      throw new CommunicationAccessError("You are not a participant of this conversation", 403);
    }
    return { conversation, participant };
  }

  /** DIRECT conversations only — the calling feature (1-to-1 only)
   * relies on this returning exactly one other user. */
  static async getOtherParticipantId(conversation, userId) {
    return conversation.participantAId === userId
      ? conversation.participantBId
      : conversation.participantAId;
  }

  /** Every OTHER active participant's userId — one for DIRECT, N for
   * GROUP. This is what every message-notification fan-out (new
   * message/attachment/voice) should loop over instead of assuming a
   * single recipient. */
  static async getOtherParticipantIds(models, tenantId, conversation, userId) {
    const { CommunicationParticipant } = models;
    if (conversation.type === CONVERSATION_TYPES.DIRECT) {
      const otherId = await CommunicationService.getOtherParticipantId(conversation, userId);
      return otherId ? [otherId] : [];
    }
    const rows = await CommunicationParticipant.findAll({
      where: { tenantId, conversationId: conversation.id, leftAt: null, userId: { [Op.ne]: userId } },
      attributes: ["userId"],
    });
    return rows.map((r) => r.userId);
  }

  // ── Conversations list ──────────────────────────────────────────
  static async listConversations(models, masterModels, tenantId, userId, { search = "" } = {}) {
    const { User, CommunicationConversation, CommunicationParticipant, CommunicationMessage } = models;
    const memberships = await CommunicationParticipant.findAll({
      where: { tenantId, userId, archivedAt: null, leftAt: null },
    });
    if (!memberships.length) return [];

    const conversationIds = memberships.map((m) => m.conversationId);
    const membershipByConvId = new Map(memberships.map((m) => [m.conversationId, m]));

    const conversations = await CommunicationConversation.findAll({
      where: { id: conversationIds, tenantId },
      order: [["lastMessageAt", "DESC"]],
    });

    const directConvs = conversations.filter((c) => c.type === CONVERSATION_TYPES.DIRECT);
    const groupConvs = conversations.filter((c) => c.type === CONVERSATION_TYPES.GROUP);

    // ── DIRECT: resolve the other user for each conversation ────────
    const otherUserIds = directConvs.map((c) => (c.participantAId === userId ? c.participantBId : c.participantAId));
    const otherUsers = await User.findAll({
      where: { id: otherUserIds, tenantId },
      attributes: ["id", "name", "email", "role", "isActive"],
    });
    const userById = new Map(otherUsers.map((u) => [u.id, u]));
    const departmentByUserId = await CommunicationService._resolveDepartments(models, masterModels, tenantId, otherUserIds);

    // ── GROUP: resolve member counts + a short name preview ────────
    const groupIds = groupConvs.map((c) => c.id);
    const groupMemberRows = groupIds.length
      ? await CommunicationParticipant.findAll({ where: { tenantId, conversationId: groupIds, leftAt: null } })
      : [];
    const memberIdsByConv = new Map();
    for (const row of groupMemberRows) {
      if (!memberIdsByConv.has(row.conversationId)) memberIdsByConv.set(row.conversationId, []);
      memberIdsByConv.get(row.conversationId).push(row.userId);
    }
    const allGroupMemberIds = [...new Set(groupMemberRows.map((r) => r.userId))];
    const groupMemberUsers = allGroupMemberIds.length
      ? await User.findAll({ where: { id: allGroupMemberIds, tenantId }, attributes: ["id", "name"] })
      : [];
    const groupUserById = new Map(groupMemberUsers.map((u) => [u.id, u]));

    const trimmed = (search || "").trim().toLowerCase();
    const results = [];

    for (const conv of directConvs) {
      const otherId = conv.participantAId === userId ? conv.participantBId : conv.participantAId;
      const otherUser = userById.get(otherId);
      if (!otherUser) continue; // defensive: participant deactivated/removed

      if (trimmed && !otherUser.name?.toLowerCase().includes(trimmed) && !otherUser.email?.toLowerCase().includes(trimmed)) {
        continue;
      }

      const membership = membershipByConvId.get(conv.id);
      const unreadCount = await CommunicationService._unreadCountFor(
        models,
        tenantId,
        conv.id,
        membership?.lastReadMessageId || 0,
        userId
      );

      results.push({
        conversationId: conv.id,
        type: CONVERSATION_TYPES.DIRECT,
        otherUser: {
          id: otherUser.id,
          name: otherUser.name,
          email: otherUser.email,
          role: otherUser.role,
          department: departmentByUserId.get(otherUser.id) || null,
        },
        lastMessagePreview: conv.lastMessagePreview,
        lastMessageAt: conv.lastMessageAt,
        unreadCount,
        muted: !!membership?.mutedAt,
      });
    }

    for (const conv of groupConvs) {
      if (trimmed && !conv.name?.toLowerCase().includes(trimmed)) continue;

      const membership = membershipByConvId.get(conv.id);
      const unreadCount = await CommunicationService._unreadCountFor(
        models,
        tenantId,
        conv.id,
        membership?.lastReadMessageId || 0,
        userId
      );
      const memberIds = memberIdsByConv.get(conv.id) || [];

      results.push({
        conversationId: conv.id,
        type: CONVERSATION_TYPES.GROUP,
        name: conv.name,
        memberCount: memberIds.length,
        memberNames: memberIds
          .filter((id) => id !== userId)
          .slice(0, 3)
          .map((id) => groupUserById.get(id)?.name)
          .filter(Boolean),
        isAdmin: conv.createdBy === userId,
        lastMessagePreview: conv.lastMessagePreview,
        lastMessageAt: conv.lastMessageAt,
        unreadCount,
        muted: !!membership?.mutedAt,
      });
    }

    results.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
    return results;
  }

  static async _unreadCountFor(models, tenantId, conversationId, lastReadMessageId, userId) {
    const { CommunicationMessage } = models;
    return CommunicationMessage.count({
      where: {
        tenantId,
        conversationId,
        id: { [Op.gt]: lastReadMessageId || 0 },
        senderId: { [Op.ne]: userId },
        deletedAt: null,
      },
    });
  }

  static async getTotalUnreadCount(models, tenantId, userId) {
    const { CommunicationParticipant } = models;
    const memberships = await CommunicationParticipant.findAll({
      where: { tenantId, userId, archivedAt: null, leftAt: null },
    });
    let total = 0;
    for (const m of memberships) {
      total += await CommunicationService._unreadCountFor(
        models,
        tenantId,
        m.conversationId,
        m.lastReadMessageId || 0,
        userId
      );
    }
    return total;
  }

  // ── Messages ─────────────────────────────────────────────────────
  /** Cursor-based pagination: pass `beforeId` (a message id) to load the
   * page immediately older than it. Omit for the most recent page. */
  static async listMessages(models, tenantId, userId, conversationId, { beforeId, limit } = {}) {
    const { User, CommunicationMessage, CommunicationVoiceMessage, CommunicationAttachment } = models;
    await CommunicationService.verifyParticipant(models, tenantId, userId, conversationId);

    const safeLimit = Math.min(Math.max(Number(limit) || MESSAGE_PAGE_SIZE_DEFAULT, 1), MESSAGE_PAGE_SIZE_MAX);
    const where = { tenantId, conversationId };
    if (beforeId) where.id = { [Op.lt]: Number(beforeId) };

    const rows = await CommunicationMessage.findAll({
      where,
      order: [["id", "DESC"]],
      limit: safeLimit,
      include: [
        { model: User, as: "sender", attributes: ["id", "name", "email"] },
        { model: CommunicationVoiceMessage, as: "voice" },
        { model: CommunicationAttachment, as: "attachments" },
        {
          model: CommunicationMessage,
          as: "replyToMessage",
          attributes: ["id", "content", "senderId", "messageType", "deletedAt"],
        },
      ],
    });

    return rows.reverse().map(CommunicationService._serializeMessage);
  }

  static _serializeMessage(row) {
    const isDeleted = !!row.deletedAt;
    return {
      id: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      sender: row.sender ? { id: row.sender.id, name: row.sender.name, email: row.sender.email } : undefined,
      messageType: row.messageType,
      content: isDeleted ? null : row.content,
      isDeleted,
      editedAt: row.editedAt,
      deliveredAt: row.deliveredAt,
      createdAt: row.createdAt,
      replyToMessageId: row.replyToMessageId,
      replyPreview:
        row.replyToMessage && !row.replyToMessage.deletedAt
          ? {
              id: row.replyToMessage.id,
              senderId: row.replyToMessage.senderId,
              messageType: row.replyToMessage.messageType,
              content:
                row.replyToMessage.messageType === MESSAGE_TYPES.VOICE
                  ? "Voice message"
                  : row.replyToMessage.messageType === MESSAGE_TYPES.FILE
                  ? row.replyToMessage.content || "Attachment"
                  : row.replyToMessage.content,
            }
          : row.replyToMessage
          ? { id: row.replyToMessage.id, deleted: true }
          : null,
      voice: row.voice
        ? {
            id: row.voice.id,
            durationSeconds: row.voice.durationSeconds,
            mimeType: row.voice.mimeType,
            fileSize: row.voice.fileSize,
          }
        : undefined,
      attachments:
        row.attachments && row.attachments.length
          ? row.attachments.map((a) => ({
              id: a.id,
              originalName: a.originalName,
              mimeType: a.mimeType,
              fileSize: a.fileSize,
              fileCategory: a.fileCategory,
              width: a.width,
              height: a.height,
              scanStatus: a.scanStatus,
            }))
          : undefined,
    };
  }

  static _previewFor(message) {
    if (message.messageType === MESSAGE_TYPES.VOICE) return "🎤 Voice message";
    if (message.messageType === MESSAGE_TYPES.FILE) return "📎 Attachment";
    const text = (message.content || "").trim();
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  }

  /** Sends a TEXT (or SYSTEM) message. Voice messages go through
   * sendVoiceMessage() instead, since they also persist a
   * CommunicationVoiceMessage row from an uploaded buffer. */
  static async sendTextMessage(models, tenantId, userId, conversationId, { content, replyToMessageId } = {}) {
    const { CommunicationMessage } = models;
    const { conversation } = await CommunicationService.verifyParticipant(models, tenantId, userId, conversationId);

    const trimmed = (content || "").trim();
    if (!trimmed) {
      throw new CommunicationAccessError("Message content is required", 400);
    }
    if (trimmed.length > 5000) {
      throw new CommunicationAccessError("Message is too long", 400);
    }

    let validReplyId = null;
    if (replyToMessageId) {
      const replyTarget = await CommunicationMessage.findOne({
        where: { id: replyToMessageId, tenantId, conversationId },
      });
      if (replyTarget) validReplyId = replyTarget.id;
    }

    const message = await CommunicationMessage.create({
      tenantId,
      conversationId,
      senderId: userId,
      messageType: MESSAGE_TYPES.TEXT,
      content: trimmed,
      replyToMessageId: validReplyId,
    });

    await CommunicationService._touchConversation(conversation, message, trimmed);

    return CommunicationService.getMessageById(models, tenantId, message.id);
  }

  static async sendVoiceMessage(
    models,
    tenantId,
    userId,
    conversationId,
    { storageKey, mimeType, fileSize, durationSeconds, waveformJson, replyToMessageId } = {}
  ) {
    const { CommunicationMessage, CommunicationVoiceMessage } = models;
    const { conversation } = await CommunicationService.verifyParticipant(models, tenantId, userId, conversationId);

    let validReplyId = null;
    if (replyToMessageId) {
      const replyTarget = await CommunicationMessage.findOne({
        where: { id: replyToMessageId, tenantId, conversationId },
      });
      if (replyTarget) validReplyId = replyTarget.id;
    }

    const message = await CommunicationMessage.create({
      tenantId,
      conversationId,
      senderId: userId,
      messageType: MESSAGE_TYPES.VOICE,
      content: null,
      replyToMessageId: validReplyId,
    });

    await CommunicationVoiceMessage.create({
      tenantId,
      messageId: message.id,
      storageProvider: "local",
      storageKey,
      mimeType,
      fileSize,
      durationSeconds,
      waveformJson: waveformJson ? JSON.stringify(waveformJson) : null,
    });

    await CommunicationService._touchConversation(conversation, message, "🎤 Voice message");

    return CommunicationService.getMessageById(models, tenantId, message.id);
  }

  /** Sends a message that carries one or more file attachments, with
   * optional accompanying text (Slack/Teams-style "text + files" in one
   * message). Attachment rows must already be validated + saved to
   * storage by the controller (CommunicationAttachmentStorageService) —
   * this method only persists the already-known metadata. */
  static async sendAttachmentMessage(
    models,
    tenantId,
    userId,
    conversationId,
    { content, replyToMessageId, attachments = [] } = {}
  ) {
    const { CommunicationMessage, CommunicationAttachment } = models;
    const { conversation } = await CommunicationService.verifyParticipant(models, tenantId, userId, conversationId);

    if (!attachments.length) {
      throw new CommunicationAccessError("At least one attachment is required", 400);
    }

    const trimmed = (content || "").trim();
    if (trimmed.length > 5000) {
      throw new CommunicationAccessError("Message is too long", 400);
    }

    let validReplyId = null;
    if (replyToMessageId) {
      const replyTarget = await CommunicationMessage.findOne({
        where: { id: replyToMessageId, tenantId, conversationId },
      });
      if (replyTarget) validReplyId = replyTarget.id;
    }

    const message = await CommunicationMessage.create({
      tenantId,
      conversationId,
      senderId: userId,
      messageType: MESSAGE_TYPES.FILE,
      content: trimmed || null,
      replyToMessageId: validReplyId,
    });

    await CommunicationAttachment.bulkCreate(
      attachments.map((a) => ({
        tenantId,
        messageId: message.id,
        storageProvider: "local",
        storageKey: a.storageKey,
        originalName: a.originalName,
        mimeType: a.mimeType,
        fileSize: a.fileSize,
        fileCategory: a.fileCategory,
        width: a.width || null,
        height: a.height || null,
        scanStatus: a.scanStatus || "SKIPPED",
      }))
    );

    const preview =
      attachments.length === 1 ? `📎 ${attachments[0].originalName}` : `📎 ${attachments.length} files`;
    await CommunicationService._touchConversation(conversation, message, preview);

    return CommunicationService.getMessageById(models, tenantId, message.id);
  }

  static async _touchConversation(conversation, message, previewSource) {
    conversation.lastMessageId = message.id;
    conversation.lastMessageAt = message.createdAt;
    conversation.lastMessagePreview =
      typeof previewSource === "string" && previewSource.length <= 180
        ? previewSource
        : CommunicationService._previewFor(message);
    await conversation.save();
  }

  static async getMessageById(models, tenantId, messageId) {
    const { User, CommunicationMessage, CommunicationVoiceMessage, CommunicationAttachment } = models;
    const row = await CommunicationMessage.findOne({
      where: { id: messageId, tenantId },
      include: [
        { model: User, as: "sender", attributes: ["id", "name", "email"] },
        { model: CommunicationVoiceMessage, as: "voice" },
        { model: CommunicationAttachment, as: "attachments" },
        {
          model: CommunicationMessage,
          as: "replyToMessage",
          attributes: ["id", "content", "senderId", "messageType", "deletedAt"],
        },
      ],
    });
    if (!row) return null;
    return CommunicationService._serializeMessage(row);
  }

  static async editMessage(models, tenantId, userId, messageId, newContent) {
    const { CommunicationMessage, CommunicationConversation } = models;
    const message = await CommunicationMessage.findOne({
      where: { id: messageId, tenantId },
    });
    if (!message) throw new CommunicationAccessError("Message not found", 404);
    if (message.senderId !== userId) {
      throw new CommunicationAccessError("You can only edit your own messages", 403);
    }
    if (message.deletedAt) {
      throw new CommunicationAccessError("Cannot edit a deleted message", 400);
    }
    if (message.messageType !== MESSAGE_TYPES.TEXT) {
      throw new CommunicationAccessError("Only text messages can be edited", 400);
    }

    const trimmed = (newContent || "").trim();
    if (!trimmed) throw new CommunicationAccessError("Message content is required", 400);

    message.content = trimmed;
    message.editedAt = new Date();
    await message.save();

    // Keep the conversation-list preview in sync if this was the last message.
    const conversation = await CommunicationConversation.findOne({
      where: { id: message.conversationId, tenantId },
    });
    if (conversation && conversation.lastMessageId === message.id) {
      conversation.lastMessagePreview = CommunicationService._previewFor(message);
      await conversation.save();
    }

    return CommunicationService.getMessageById(models, tenantId, message.id);
  }

  static async deleteMessage(models, tenantId, userId, messageId) {
    const { CommunicationMessage, CommunicationConversation } = models;
    const message = await CommunicationMessage.findOne({
      where: { id: messageId, tenantId },
    });
    if (!message) throw new CommunicationAccessError("Message not found", 404);
    if (message.senderId !== userId) {
      throw new CommunicationAccessError("You can only delete your own messages", 403);
    }
    if (message.deletedAt) return CommunicationService.getMessageById(models, tenantId, message.id);

    message.deletedAt = new Date();
    await message.save();

    const conversation = await CommunicationConversation.findOne({
      where: { id: message.conversationId, tenantId },
    });
    if (conversation && conversation.lastMessageId === message.id) {
      conversation.lastMessagePreview = "This message was deleted";
      await conversation.save();
    }

    return CommunicationService.getMessageById(models, tenantId, message.id);
  }

  // ── Read receipts ───────────────────────────────────────────────
  static async markConversationRead(models, tenantId, userId, conversationId) {
    const { CommunicationMessage } = models;
    const { participant } = await CommunicationService.verifyParticipant(models, tenantId, userId, conversationId);

    const latest = await CommunicationMessage.findOne({
      where: { tenantId, conversationId },
      order: [["id", "DESC"]],
    });
    if (!latest) return { lastReadMessageId: participant.lastReadMessageId || null };

    participant.lastReadMessageId = latest.id;
    participant.lastReadAt = new Date();
    await participant.save();

    return { lastReadMessageId: latest.id, lastReadAt: participant.lastReadAt };
  }

  static async markMessageDelivered(models, tenantId, messageId) {
    const { CommunicationMessage } = models;
    const message = await CommunicationMessage.findOne({ where: { id: messageId, tenantId } });
    if (!message || message.deliveredAt) return message;
    message.deliveredAt = new Date();
    await message.save();
    return message;
  }
}

module.exports = CommunicationService;
module.exports.CommunicationAccessError = CommunicationAccessError;
