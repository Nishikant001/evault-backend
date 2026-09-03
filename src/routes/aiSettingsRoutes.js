// src/routes/aiSettingsRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const { loadSubscription, requireAI } = require("../middleware/subscriptionMiddleware"); // NEW (Subscription Management System)
const {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  getSettings,
  updateSettings,
} = require("../controllers/aiSettingsController");

const READ_ROLES = ["SuperAdmin", "TenantAdmin", "BranchManager", "DeptHead", "Manager", "Auditor"];

// AI provider/settings configuration is itself an AI Assistant capability
// -> gated the same as the rest of the AI module.
router.use(auth, loadSubscription, requireAI);

// ── Providers ──────────────────────────────────────────────────
// POST   /api/ai/providers        → add a provider (OpenAI/Anthropic/Gemini/Azure/Ollama)
// GET    /api/ai/providers        → list this tenant's providers (keys masked)
// PUT    /api/ai/providers/:id    → update a provider
// DELETE /api/ai/providers/:id    → remove a provider
router.post("/providers", role("SuperAdmin", "TenantAdmin"), createProvider);
router.get("/providers", role(...READ_ROLES), listProviders);
router.put("/providers/:id", role("SuperAdmin", "TenantAdmin"), updateProvider);
router.delete("/providers/:id", role("SuperAdmin", "TenantAdmin"), deleteProvider);

// ── Settings ───────────────────────────────────────────────────
// GET /api/ai/settings  → this tenant's AI configuration
// PUT /api/ai/settings  → update chunking/vector-store/default-provider settings
router.get("/settings", role(...READ_ROLES), getSettings);
router.put("/settings", role("SuperAdmin", "TenantAdmin"), updateSettings);

module.exports = router;
