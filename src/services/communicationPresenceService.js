// src/services/communicationPresenceService.js
//
// In-memory online/offline presence + typing-indicator state.
//
// Deliberately NOT persisted to MySQL (project brief §21/§20 — do not
// write every presence heartbeat or typing event to the DB). Works
// correctly with a single Node.js instance; the shape below (a couple of
// plain Maps keyed by tenant+user) is intentionally simple so it can be
// swapped for a Redis-backed implementation later (see §38) without
// touching any calling code — every method here is already async-shaped.

const { TYPING_TIMEOUT_MS } = require("../constants/communicationConstants");

// tenantId -> Map<userId, Set<socketId>>  (a user can have multiple tabs/devices)
const onlineUsers = new Map();

// conversationId -> Map<userId, NodeJS.Timeout>  (auto-clears stale typing state)
const typingTimers = new Map();

function tenantMap(tenantId) {
  if (!onlineUsers.has(tenantId)) onlineUsers.set(tenantId, new Map());
  return onlineUsers.get(tenantId);
}

class CommunicationPresenceService {
  /** Marks a socket connection online for a user. Returns true if this is
   * the user's FIRST active connection (i.e. they just came online). */
  static addConnection(tenantId, userId, socketId) {
    const users = tenantMap(tenantId);
    const wasOffline = !users.has(userId) || users.get(userId).size === 0;
    if (!users.has(userId)) users.set(userId, new Set());
    users.get(userId).add(socketId);
    return wasOffline;
  }

  /** Removes a socket connection. Returns true if the user has now gone
   * fully offline (no more active connections). */
  static removeConnection(tenantId, userId, socketId) {
    const users = tenantMap(tenantId);
    if (!users.has(userId)) return true;
    users.get(userId).delete(socketId);
    const nowOffline = users.get(userId).size === 0;
    if (nowOffline) users.delete(userId);
    return nowOffline;
  }

  static isOnline(tenantId, userId) {
    const users = onlineUsers.get(tenantId);
    return !!users?.get(userId)?.size;
  }

  static getOnlineUserIds(tenantId) {
    const users = onlineUsers.get(tenantId);
    if (!users) return [];
    return Array.from(users.keys());
  }

  /** Registers that `userId` is typing in `conversationId`; auto-expires
   * after TYPING_TIMEOUT_MS as a safety net if "stop-typing" is lost
   * (client crash, tab close without a clean disconnect, etc).
   * `onExpire` is invoked once, when the timer actually fires. */
  static setTyping(conversationId, userId, onExpire) {
    const key = `${conversationId}:${userId}`;
    if (typingTimers.has(key)) clearTimeout(typingTimers.get(key));
    const timer = setTimeout(() => {
      typingTimers.delete(key);
      onExpire?.();
    }, TYPING_TIMEOUT_MS);
    typingTimers.set(key, timer);
  }

  static clearTyping(conversationId, userId) {
    const key = `${conversationId}:${userId}`;
    if (typingTimers.has(key)) {
      clearTimeout(typingTimers.get(key));
      typingTimers.delete(key);
    }
  }
}

module.exports = CommunicationPresenceService;
