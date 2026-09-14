// routes/userRoutes.js

const express = require("express");
const router = express.Router();

const authMiddleware  = require("../middleware/authMiddleware");
const roleMiddleware  = require("../middleware/roleMiddleware");
const UserController  = require("../controllers/userController");

// Create user — TenantAdmin only
router.post(
  "/",
  authMiddleware,
  roleMiddleware("SuperAdmin", "TenantAdmin"),
  UserController.create
);

// Get all users in tenant — TenantAdmin only
router.get(
  "/",
  authMiddleware,
  roleMiddleware("SuperAdmin", "TenantAdmin"),
  UserController.getAll
);

// My profile — any logged-in user
router.get(
  "/profile",
  authMiddleware,
  UserController.profile
);

// Change own password
router.post(
  "/change-password",
  authMiddleware,
  UserController.changePassword
);

// Update user (name / role / isActive) — TenantAdmin only
router.put(
  "/:id",
  authMiddleware,
  roleMiddleware("SuperAdmin", "TenantAdmin"),
  UserController.update
);

// Delete user — TenantAdmin only
router.delete(
  "/:id",
  authMiddleware,
  roleMiddleware("SuperAdmin", "TenantAdmin"),
  UserController.remove
);

module.exports = router;