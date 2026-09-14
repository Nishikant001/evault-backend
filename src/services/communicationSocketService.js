// src/services/communicationSocketService.js
//
// Socket.IO integration for the Internal Communication Module.
//
// Authentication: reuses the EXISTING JWT (same secret/shape as
// authMiddleware.js / jwtService.js) — no second auth mechanism.
// Rooms: `user:{userId}` (personal, joined automatically on connect) and
// `conversation:{conversationId}` (joined only after the server verifies
// tenant + participant membership).
//
// REST + MySQL remain the source of truth: every socket-emitted business
// event (message:new, edited, deleted, read) is emitted by the
// CONTROLLER after the DB write succeeds, not by this service acting on
// unverified client input. The one exception is typing indicators, which
// are transient by design and never touch the database.
//
// MERGE — tenant-aware rewrite. There is no request object on a socket
// connection, so this file cannot rely on tenantResolverMiddleware.
// Instead:
//   - SuperAdmin identity/tenant lookups go through the Master DB
//     directly (masterModels.Tenant / SuperAdmin), exactly like
//     tenantResolverMiddleware.js does for HTTP requests.
//   - A tenant user's own physical database connection + tenant model
//     set is resolved ONCE per socket connection via
//     tenantConnectionManager.getTenantConnection(tenantId) and cached
//     on `socket.models` for the lifetime of that connection — every
//     event handler below reuses socket.models rather than re-resolving
//     the connection on every single message/call event.
//   - A socket authenticated for Tenant A therefore can never reach
//     Tenant B's data: it never even holds a reference to Tenant B's
//     Sequelize connection or User table.

const jwt = require("jsonwebtoken");
const masterModels = require("../models/masterDb");
const { getTenantConnection, TenantProvisioningError } = require("./tenantConnectionManager");
const CommunicationService = require("./communicationService");
const CommunicationPresenceService = require("./communicationPresenceService");
const CommunicationCallService = require("./communicationCallService");
const NotificationCenterService = require("./notificationCenterService");
const AuditService = require("./auditService");
const { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_STATUS } = require("../constants/auditActions");
const { SOCKET_EVENTS, CALL_TYPES, CALL_STATUS, CALL_CONFIG } = require("../constants/communicationConstants");

function userRoom(userId) {
  return `user:${userId}`;
}
function conversationRoom(conversationId) {
  return `conversation:${conversationId}`;
}

// ── Call signalling state (in-memory, single-instance — SDP/ICE
// payloads are never persisted, only the call lifecycle is, via
// CommunicationCallService). ───────────────────────────────────────
// callId -> { tenantId, conversationId, callerId, calleeId, callType, status, ringTimer }
const activeCallsById = new Map();
// userId -> callId  (enforces "one active call at a time" per user)
const activeCallIdByUser = new Map();

function isUserInCall(userId) {
  return activeCallIdByUser.has(userId);
}
function registerCall(call) {
  activeCallsById.set(call.id, call);
  activeCallIdByUser.set(call.callerId, call.id);
  activeCallIdByUser.set(call.calleeId, call.id);
}
function clearCall(callId) {
  const call = activeCallsById.get(callId);
  if (!call) return null;
  if (call.ringTimer) clearTimeout(call.ringTimer);
  activeCallsById.delete(callId);
  if (activeCallIdByUser.get(call.callerId) === callId) activeCallIdByUser.delete(call.callerId);
  if (activeCallIdByUser.get(call.calleeId) === callId) activeCallIdByUser.delete(call.calleeId);
  return call;
}
/** Terminal status inferred from where the call was when it ended,
 * used for both explicit CALL_END and disconnect-triggered cleanup. */
function terminalStatusFor(call) {
  if (call.status === CALL_STATUS.CONNECTED) return CALL_STATUS.COMPLETED;
  if (call.status === CALL_STATUS.RINGING) return CALL_STATUS.CANCELLED;
  return CALL_STATUS.FAILED;
}

let ioInstance = null;

function init(server) {
  // Lazy require: keeps this file loadable (and unit-testable) even in
  // environments where socket.io hasn't been installed yet.
  const { Server } = require("socket.io");

  const io = new Server(server, {
    cors: {
      origin: (process.env.COMMUNICATION_SOCKET_ORIGIN || "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173")
        .split(",")
        .map((s) => s.trim()),
      credentials: true,
    },
    path: "/socket.io",
  });

  // ── Authentication middleware — every connection must present the
  // same JWT the REST API uses (Authorization header pattern, sent via
  // the client's `auth: { token }` handshake option). SuperAdmin
  // sockets are rejected outright — the communication module is a
  // tenant-user feature, mirroring tenantResolverMiddleware's own
  // "do not force SuperAdmin through tenant resolution" bypass (there
  // is no tenant conversation for a SuperAdmin to join in the first
  // place). ────────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace("Bearer ", "");
      if (!token) return next(new Error("Authentication token missing"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded || !decoded.id || !decoded.role) return next(new Error("Invalid or expired token"));

      if (decoded.role === "SuperAdmin") {
        return next(new Error("Communication is not available for SuperAdmin sessions"));
      }

      const tenantId = decoded.tenantId;
      if (!tenantId) return next(new Error("User has no tenant assigned"));

      const tenant = await masterModels.Tenant.findByPk(tenantId);
      if (!tenant || tenant.status !== "ACTIVE") return next(new Error("Invalid tenant"));

      let conn;
      try {
        conn = await getTenantConnection(tenantId);
      } catch (err) {
        if (err instanceof TenantProvisioningError) return next(new Error(err.message));
        throw err;
      }

      const user = await conn.models.User.findByPk(decoded.id);
      if (!user) return next(new Error("User not found"));
      if (!user.isActive) return next(new Error("User is inactive"));

      socket.user = {
        id: user.id,
        role: user.role,
        tenantId,
        name: user.name,
        email: user.email,
      };
      // Cached ONCE per socket connection — every handler below reuses
      // this instead of re-resolving getTenantConnection() per event.
      socket.models = conn.models;
      next();
    } catch (error) {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId, tenantId } = socket.user;
    const models = socket.models;

    // Personal room — used to push events to a user regardless of which
    // conversation screen (if any) they currently have open.
    socket.join(userRoom(userId));

    const wasOffline = CommunicationPresenceService.addConnection(tenantId, userId, socket.id);
    socket.emit(SOCKET_EVENTS.CONNECTED, { userId, tenantId });

    if (wasOffline) {
      io.to(`tenant:${tenantId}`).emit(SOCKET_EVENTS.USER_ONLINE, { userId });
    }
    // Every socket also joins a tenant-wide room so presence broadcasts
    // stay tenant-scoped rather than global.
    socket.join(`tenant:${tenantId}`);

    // ── Join a conversation room — ONLY after verifying membership.
    // A malicious client emitting an arbitrary conversationId simply
    // gets an error event back and never joins the room. ─────────
    socket.on(SOCKET_EVENTS.JOIN_CONVERSATION, async ({ conversationId } = {}, ack) => {
      try {
        await CommunicationService.verifyParticipant(models, tenantId, userId, Number(conversationId));
        socket.join(conversationRoom(conversationId));
        ack?.({ success: true });
      } catch (error) {
        ack?.({ success: false, message: "Not authorized for this conversation" });
        socket.emit(SOCKET_EVENTS.ERROR, { message: "Not authorized for this conversation" });
      }
    });

    socket.on(SOCKET_EVENTS.LEAVE_CONVERSATION, ({ conversationId } = {}) => {
      if (conversationId) socket.leave(conversationRoom(conversationId));
    });

    // ── Typing indicators — transient only, never persisted ──
    socket.on(SOCKET_EVENTS.MESSAGE_TYPING, async ({ conversationId } = {}) => {
      if (!conversationId) return;
      try {
        await CommunicationService.verifyParticipant(models, tenantId, userId, Number(conversationId));
      } catch {
        return;
      }
      socket.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.MESSAGE_TYPING, {
        conversationId: Number(conversationId),
        userId,
      });
      CommunicationPresenceService.setTyping(conversationId, userId, () => {
        socket.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.MESSAGE_STOP_TYPING, {
          conversationId: Number(conversationId),
          userId,
        });
      });
    });

    socket.on(SOCKET_EVENTS.MESSAGE_STOP_TYPING, ({ conversationId } = {}) => {
      if (!conversationId) return;
      CommunicationPresenceService.clearTyping(conversationId, userId);
      socket.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.MESSAGE_STOP_TYPING, {
        conversationId: Number(conversationId),
        userId,
      });
    });

    // ── Calling — WebRTC signalling ─────────────────────────────────
    // Every handler re-verifies the acting user is a legitimate
    // participant of the call/conversation server-side — a crafted
    // callId or conversationId from a malicious client never reaches
    // another user without that check passing first.

    socket.on(SOCKET_EVENTS.CALL_INVITE, async ({ conversationId, callType } = {}, ack) => {
      try {
        if (!conversationId || !Object.values(CALL_TYPES).includes(callType)) {
          ack?.({ success: false, message: "Invalid call request" });
          return;
        }
        if (isUserInCall(userId)) {
          ack?.({ success: false, reason: "self-busy", message: "You already have an active call" });
          return;
        }

        const { conversation } = await CommunicationService.verifyParticipant(models, tenantId, userId, Number(conversationId));
        if (conversation.type !== "DIRECT") {
          ack?.({ success: false, message: "Calling is currently only available for 1-to-1 conversations" });
          return;
        }
        const calleeId = await CommunicationService.getOtherParticipantId(conversation, userId);

        if (isUserInCall(calleeId)) {
          ack?.({ success: false, reason: "busy", message: "This user is currently on another call" });
          return;
        }

        if (!CommunicationPresenceService.isOnline(tenantId, calleeId)) {
          const record = await CommunicationCallService.createRinging(models, {
            tenantId,
            conversationId: Number(conversationId),
            callerId: userId,
            calleeId,
            callType,
          });
          await CommunicationCallService.finalize(models, tenantId, record.id, CALL_STATUS.MISSED);
          ack?.({ success: false, reason: "offline", message: "This user is currently offline" });
          return;
        }

        const record = await CommunicationCallService.createRinging(models, {
          tenantId,
          conversationId: Number(conversationId),
          callerId: userId,
          calleeId,
          callType,
        });
        const callId = record.id;

        const ringTimer = setTimeout(async () => {
          const call = activeCallsById.get(callId);
          if (!call || call.status !== CALL_STATUS.RINGING) return;
          clearCall(callId);
          await CommunicationCallService.finalize(models, tenantId, callId, CALL_STATUS.MISSED);
          emitToUser(userId, SOCKET_EVENTS.CALL_TIMEOUT, { callId });
          emitToUser(calleeId, SOCKET_EVENTS.CALL_TIMEOUT, { callId });
          NotificationCenterService.create(models, {
            tenantId,
            userId: calleeId,
            type: "COMMUNICATION_MISSED_CALL",
            title: `Missed ${callType.toLowerCase()} call`,
            message: `You missed a ${callType.toLowerCase()} call from ${socket.user.name || socket.user.email}`,
          }).catch(() => {});
        }, CALL_CONFIG.ringTimeoutMs);

        registerCall({
          id: callId,
          tenantId,
          conversationId: Number(conversationId),
          callerId: userId,
          calleeId,
          callType,
          status: CALL_STATUS.RINGING,
          ringTimer,
        });

        emitToUser(calleeId, SOCKET_EVENTS.CALL_INVITE, {
          callId,
          conversationId: Number(conversationId),
          callType,
          caller: { id: userId, name: socket.user.name, email: socket.user.email },
        });

        ack?.({ success: true, callId });

        AuditService.log({
          models,
          tenantId,
          userId,
          action: AUDIT_ACTIONS.COMMUNICATION_CALL_INITIATED,
          module: AUDIT_MODULES.COMMUNICATION,
          remarks: `Initiated ${callType} call ${callId} in conversation ${conversationId}`,
          status: AUDIT_STATUS.SUCCESS,
        }).catch(() => {});
      } catch (error) {
        ack?.({ success: false, message: error.message || "Could not start the call" });
      }
    });

    socket.on(SOCKET_EVENTS.CALL_ACCEPT, async ({ callId } = {}, ack) => {
      const call = activeCallsById.get(callId);
      if (!call || call.tenantId !== tenantId || call.calleeId !== userId) {
        ack?.({ success: false, message: "Call is no longer available" });
        return;
      }
      if (call.ringTimer) clearTimeout(call.ringTimer);
      call.status = CALL_STATUS.CONNECTING;
      await CommunicationCallService.markConnecting(models, tenantId, callId);
      emitToUser(call.callerId, SOCKET_EVENTS.CALL_ACCEPT, { callId });
      ack?.({ success: true });
    });

    socket.on(SOCKET_EVENTS.CALL_DECLINE, async ({ callId } = {}) => {
      const call = activeCallsById.get(callId);
      if (!call || call.tenantId !== tenantId || call.calleeId !== userId) return;
      clearCall(callId);
      await CommunicationCallService.finalize(models, tenantId, callId, CALL_STATUS.DECLINED);
      emitToUser(call.callerId, SOCKET_EVENTS.CALL_DECLINE, { callId });
    });

    socket.on(SOCKET_EVENTS.CALL_CANCEL, async ({ callId } = {}) => {
      const call = activeCallsById.get(callId);
      if (!call || call.tenantId !== tenantId || call.callerId !== userId) return;
      clearCall(callId);
      await CommunicationCallService.finalize(models, tenantId, callId, CALL_STATUS.CANCELLED);
      emitToUser(call.calleeId, SOCKET_EVENTS.CALL_CANCEL, { callId });
    });

    // SDP offer/answer — reused for both the initial negotiation and any
    // later renegotiation (ICE restart on reconnect), so the same two
    // events cover both cases; the client decides which it's doing.
    socket.on(SOCKET_EVENTS.CALL_OFFER, ({ callId, sdp } = {}) => {
      const call = activeCallsById.get(callId);
      if (!call || call.tenantId !== tenantId) return;
      if (call.callerId !== userId && call.calleeId !== userId) return;
      const otherId = call.callerId === userId ? call.calleeId : call.callerId;
      emitToUser(otherId, SOCKET_EVENTS.CALL_OFFER, { callId, sdp });
    });

    socket.on(SOCKET_EVENTS.CALL_ANSWER, async ({ callId, sdp } = {}) => {
      const call = activeCallsById.get(callId);
      if (!call || call.tenantId !== tenantId) return;
      if (call.callerId !== userId && call.calleeId !== userId) return;
      const otherId = call.callerId === userId ? call.calleeId : call.callerId;
      emitToUser(otherId, SOCKET_EVENTS.CALL_ANSWER, { callId, sdp });
      if (call.status !== CALL_STATUS.CONNECTED) {
        call.status = CALL_STATUS.CONNECTED;
        await CommunicationCallService.markConnected(models, tenantId, callId);
      }
    });

    socket.on(SOCKET_EVENTS.CALL_ICE_CANDIDATE, ({ callId, candidate } = {}) => {
      const call = activeCallsById.get(callId);
      if (!call || call.tenantId !== tenantId) return;
      if (call.callerId !== userId && call.calleeId !== userId) return;
      const otherId = call.callerId === userId ? call.calleeId : call.callerId;
      emitToUser(otherId, SOCKET_EVENTS.CALL_ICE_CANDIDATE, { callId, candidate });
    });

    socket.on(SOCKET_EVENTS.CALL_END, async ({ callId } = {}) => {
      const call = activeCallsById.get(callId);
      if (!call || call.tenantId !== tenantId) return;
      if (call.callerId !== userId && call.calleeId !== userId) return;
      const otherId = call.callerId === userId ? call.calleeId : call.callerId;
      const status = terminalStatusFor(call);
      clearCall(callId);
      await CommunicationCallService.finalize(models, tenantId, callId, status);
      emitToUser(otherId, SOCKET_EVENTS.CALL_END, { callId });
      AuditService.log({
        models,
        tenantId,
        userId,
        action: AUDIT_ACTIONS.COMMUNICATION_CALL_ENDED,
        module: AUDIT_MODULES.COMMUNICATION,
        remarks: `Ended call ${callId}`,
        status: AUDIT_STATUS.SUCCESS,
      }).catch(() => {});
    });

    socket.on("disconnect", () => {
      const nowOffline = CommunicationPresenceService.removeConnection(tenantId, userId, socket.id);
      if (nowOffline) {
        io.to(`tenant:${tenantId}`).emit(SOCKET_EVENTS.USER_OFFLINE, { userId, lastSeenAt: new Date() });
      }

      // ── Call cleanup — a user closing their tab/losing connection
      // mid-call must not leave the other party's UI stuck or the
      // server's "one active call per user" state stale. ────────────
      const callId = activeCallIdByUser.get(userId);
      if (callId) {
        const call = clearCall(callId);
        if (call) {
          const otherId = call.callerId === userId ? call.calleeId : call.callerId;
          emitToUser(otherId, SOCKET_EVENTS.CALL_END, { callId, reason: "peer-disconnected" });
          CommunicationCallService.finalize(models, call.tenantId, callId, terminalStatusFor(call)).catch(() => {});
        }
      }
    });
  });

  ioInstance = io;
  return io;
}

function getIO() {
  if (!ioInstance) {
    throw new Error("Communication Socket.IO service not initialized — call init(server) first");
  }
  return ioInstance;
}

/** Emits an event to every active connection a user has (their personal room). */
function emitToUser(userId, event, payload) {
  if (!ioInstance) return;
  ioInstance.to(userRoom(userId)).emit(event, payload);
}

/** Emits an event to everyone currently viewing a conversation. */
function emitToConversation(conversationId, event, payload) {
  if (!ioInstance) return;
  ioInstance.to(conversationRoom(conversationId)).emit(event, payload);
}

function isUserOnline(tenantId, userId) {
  return CommunicationPresenceService.isOnline(tenantId, userId);
}

module.exports = {
  init,
  getIO,
  emitToUser,
  emitToConversation,
  isUserOnline,
  userRoom,
  conversationRoom,
};
