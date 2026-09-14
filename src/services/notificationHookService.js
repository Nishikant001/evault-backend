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
    console.log(
      `[NotificationHook] ${event}`,
      JSON.stringify(payload)
    );

    const NotificationCenterService = require(
      "./notificationCenterService"
    );

    const {
      models,
      tenantId,
      recipientUserIds = [],
      documentId,
      documentApprovalId,
      levelNumber,
      actorId,
      title,
      message,
      metadata = {},
    } = payload;

    if (!models || !tenantId) {
      return;
    }

    if (!recipientUserIds.length) {
      return;
    }

    for (const userId of recipientUserIds) {
      await NotificationCenterService.create(models, {
        tenantId,
        userId,
        type: event,
        title:
          title ||
          NotificationHookService.getTitle(event),
        message:
          message ||
          NotificationHookService.getMessage(event, payload),
        metadata: {
          documentId,
          documentApprovalId,
          levelNumber,
          actorId,
          ...metadata,
        },
      });
    }
  } catch (error) {
    // Notification failures must never break approval transactions.
    console.log(
      "NotificationHook Error:",
      error.message
    );
  }
}
static getTitle(event) {
  const titles = {
    APPROVAL_SUBMITTED: "Document submitted for approval",
    APPROVAL_PENDING: "Approval required",
    APPROVAL_APPROVED: "Document approved",
    APPROVAL_COMPLETED: "Approval completed",
    APPROVAL_REJECTED: "Document rejected",
    APPROVAL_SENT_BACK: "Document sent back",
    APPROVAL_CANCELLED: "Approval cancelled",
  };

  return titles[event] || "Notification";
}

static getMessage(event, payload = {}) {
  const documentId = payload.documentId;

  const messages = {
    APPROVAL_SUBMITTED:
      `Document #${documentId} has been submitted for approval.`,

    APPROVAL_PENDING:
      `Document #${documentId} requires your approval.`,

    APPROVAL_APPROVED:
      `Document #${documentId} has been approved.`,

    APPROVAL_COMPLETED:
      `Document #${documentId} approval workflow has been completed.`,

    APPROVAL_REJECTED:
      `Document #${documentId} has been rejected.`,

    APPROVAL_SENT_BACK:
      `Document #${documentId} has been sent back for correction.`,

    APPROVAL_CANCELLED:
      `Approval for document #${documentId} has been cancelled.`,
  };

  return messages[event] || "You have a new notification.";
}
}

module.exports = NotificationHookService;
