const express = require("express");

const router = express.Router();

const AuthController =
require("../controllers/authController");

const authMiddleware =
require("../middleware/authMiddleware");

const roleMiddleware =
require("../middleware/roleMiddleware");

router.post(
  "/login",
  AuthController.login
);

router.post(
  "/refresh-token",
  AuthController.refreshToken
);

router.post(
  "/logout",
  AuthController.logout
);

router.post(
  "/register",
  authMiddleware,
  roleMiddleware(
    "SuperAdmin",
    "TenantAdmin"
  ),
  AuthController.register
);

module.exports = router;