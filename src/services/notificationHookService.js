// src/services/notificationHookService.js
//
// Notification HOOKS only — per the business requirement, no email/SMS
// implementation is included. This module gives the Approval Engine a
// single, stable call site to announce lifecycle events. A future
// notification channel (email, push, in-app) can be wired in here
// without touching the engine itself.
//
// Never throws — a notification failure must not break an approval
// transaction.

class NotificationHookService {
  /**
   * @param {string} event   - one of APPROVAL_EVENTS
   * @param {object} payload - { documentId, documentApprovalId, tenantId,
   *                             levelNumber, actorId, message, ... }
   */
  static async fire(event, payload = {}) {
    try {
      // Hook point only. Replace/extend with a real dispatcher (queue,
      // webhook, email service, websocket push, etc.) when needed.
      console.log(`[NotificationHook] ${event}`, JSON.stringify(payload));
    } catch (error) {
      console.log("NotificationHook Error:", error.message);
    }
  }
}

module.exports = NotificationHookService;
