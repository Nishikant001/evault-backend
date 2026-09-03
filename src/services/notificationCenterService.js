// src/services/notificationCenterService.js
//
// In-app dashboard notifications (bell icon). Separate from
// notificationService.js (email/SMS) — trial reminders fire both: an
// email/SMS via notificationService, and a persistent in-app row here so
// "every login should show trial expired, upgrade now" has something to
// actually render even if email/SMS delivery failed or wasn't configured.
//
// Phase 5: Notification is a per-tenant model — every method now takes
// `models` as its first parameter.

class NotificationCenterService {
  /** userId omitted/null = tenant-wide, shown to every user of that tenant. */
  static async create(models, { tenantId, userId = null, type = "SYSTEM", title, message }) {
    const { Notification } = models;
    return Notification.create({ tenantId, userId, type, title, message });
  }

  /** Returns notifications visible to this user: tenant-wide (userId=null) + their own. */
  static async listForUser(models, tenantId, userId, { unreadOnly = false, limit = 50 } = {}) {
    const { Notification } = models;
    const { Op } = require("sequelize");
    return Notification.findAll({
      where: {
        tenantId,
        userId: { [Op.or]: [null, userId] },
        ...(unreadOnly ? { isRead: false } : {}),
      },
      order: [["createdAt", "DESC"]],
      limit,
    });
  }

  static async markRead(models, id, tenantId) {
    const { Notification } = models;
    const notification = await Notification.findOne({ where: { id, tenantId } });
    if (!notification) return null;
    notification.isRead = true;
    await notification.save();
    return notification;
  }

  static async markAllRead(models, tenantId, userId) {
    const { Notification } = models;
    const { Op } = require("sequelize");
    await Notification.update(
      { isRead: true },
      { where: { tenantId, userId: { [Op.or]: [null, userId] } } },
    );
  }
}

module.exports = NotificationCenterService;
