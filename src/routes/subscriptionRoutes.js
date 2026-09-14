// src/routes/subscriptionRoutes.js
const express = require("express");
const router = express.Router();

const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const SubscriptionController = require("../controllers/subscriptionController");

// ── FREE self-registration (no auth — this IS the entry point) ────────
// Task 2 New Registration Flow:
//   Step 1: POST /api/subscriptions/register/send-otp   { mobileNumber, email }
//           POST /api/subscriptions/register/verify-otp { mobileNumber, otp }
//   Step 2: POST /api/subscriptions/register/complete    { mobileNumber, ownerName, companyName, password, confirmPassword }
router.post("/register/send-otp", SubscriptionController.sendRegistrationOtp);
router.post("/register/verify-otp", SubscriptionController.verifyRegistrationOtp);
router.post("/register/complete", SubscriptionController.completeRegistration);

// ── FREE login (no auth — this issues the token) ───────────────────────
// Task 2: Login is Email + Password only. Phone/OTP is registration-only.
// POST /api/subscriptions/login { email, password }
router.post("/login", SubscriptionController.login);

// ── Task 3: 30 Days Trial status (any authenticated tenant user) ──────
// GET /api/subscriptions/status
router.get("/status", auth, SubscriptionController.getStatus);

// ── SuperAdmin: plan/subscription administration ───────────────────────
router.get("/", auth, role("SuperAdmin"), SubscriptionController.listSubscriptions);
router.post("/:tenantId/upgrade", auth, role("SuperAdmin"), SubscriptionController.upgrade);
router.post("/:tenantId/downgrade", auth, role("SuperAdmin"), SubscriptionController.downgrade);
router.post("/:tenantId/extend-trial", auth, role("SuperAdmin"), SubscriptionController.extendTrial);
router.post("/:tenantId/deactivate-trial", auth, role("SuperAdmin"), SubscriptionController.deactivateTrial);
router.post("/:tenantId/convert-to-paid", auth, role("SuperAdmin"), SubscriptionController.convertToPaid);

module.exports = router;
