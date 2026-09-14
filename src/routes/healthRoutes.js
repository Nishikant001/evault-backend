// src/routes/healthRoutes.js
const express = require("express");
const router = express.Router();
const { health, tenantHealth } = require("../controllers/healthController");

// Public, unauthenticated — intended for Nginx/LB/orchestrator polling.
router.get("/health", health);
router.get("/health/tenant", tenantHealth);

module.exports = router;
