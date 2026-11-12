const express = require("express");

const router = express.Router();

const AuthController = require("../controllers/authController");
const BiometricAuthController = require("../controllers/biometricAuthController");

const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

// Normal Authentication
router.post("/login", AuthController.login);
router.post("/refresh-token", AuthController.refreshToken);
router.post("/logout", AuthController.logout);

router.post(
  "/register",
  authMiddleware,
  roleMiddleware("SuperAdmin", "TenantAdmin"),
  AuthController.register
);

// Biometric Authentication
router.post(
  "/biometric/enroll",
  authMiddleware,
  BiometricAuthController.enroll
);

router.post(
  "/biometric/login",
  BiometricAuthController.login
);

router.post(
  "/biometric/disable",
  authMiddleware,
  BiometricAuthController.disable
);

module.exports = router;
