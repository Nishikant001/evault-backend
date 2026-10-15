// src/routes/ocrSettingsRoutes.js
// GET  /api/ocr-settings               → masked settings + entitlement + free-engine status (TenantAdmin)
// PUT  /api/ocr-settings               → save engine/provider/credentials (TenantAdmin; licensed fields need `licensed_ocr`)
// POST /api/ocr-settings/test          → REAL provider connection test (TenantAdmin + module)
// DELETE /api/ocr-settings/credentials → clear stored credentials (TenantAdmin + module)
const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const { requireTenantModule } = require("../middleware/tenantModuleMiddleware");
const { getSettings, saveSettings, testConnection, clearCredentials } = require("../controllers/ocrSettingsController");

// Per-tenant throttle: connection tests hit an external API.
const testLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `ocr-test:${req.user && req.user.tenantId ? req.user.tenantId : "anon"}`,
  validate: { keyGeneratorIpFallback: false },
  message: { success: false, message: "Too many connection tests. Please wait a minute." },
});

router.use(auth, role("TenantAdmin"));
router.get("/", getSettings);
router.put("/", saveSettings); // entitlement for licensed fields enforced inside the service (so Tesseract-only saves still work)
router.post("/test", requireTenantModule("licensed_ocr"), testLimiter, testConnection);
router.delete("/credentials", requireTenantModule("licensed_ocr"), clearCredentials);

module.exports = router;
