// src/controllers/notificationController.js
const NotificationCenterService = require("../services/notificationCenterService");

class NotificationController {
  static async list(req, res) {
    try {
      const unreadOnly = req.query.unreadOnly === "true";
      const notifications = await NotificationCenterService.listForUser(
        req.models,
        req.user.tenantId,
        req.user.id,
        { unreadOnly },
      );
      return res.status(200).json({ success: true, data: notifications });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async markRead(req, res) {
    try {
      const notification = await NotificationCenterService.markRead(req.models, req.params.id, req.user.tenantId);
      if (!notification) return res.status(404).json({ success: false, message: "Notification not found" });
      return res.status(200).json({ success: true, data: notification });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  static async markAllRead(req, res) {
    try {
      await NotificationCenterService.markAllRead(req.models, req.user.tenantId, req.user.id);
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = NotificationController;
