// src/routes/notificationRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const NotificationController = require("../controllers/notificationController");

// GET  /api/notifications              → list mine (tenant-wide + personal)
// GET  /api/notifications?unreadOnly=true
// PUT  /api/notifications/:id/read     → mark one read
// PUT  /api/notifications/read-all     → mark all read
router.get("/", auth, NotificationController.list);

router.get(
  "/unread-count",
  auth,
  NotificationController.unreadCount
);

router.put(
  "/read-all",
  auth,
  NotificationController.markAllRead
);

router.put(
  "/:id/read",
  auth,
  NotificationController.markRead
);

module.exports = router;
