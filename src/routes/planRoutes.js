// src/routes/planRoutes.js
const express = require("express");
const router = express.Router();

const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const PlanController = require("../controllers/planController");

router.get("/", auth, role("SuperAdmin"), PlanController.list);
router.post("/", auth, role("SuperAdmin"), PlanController.create);
router.put("/:id", auth, role("SuperAdmin"), PlanController.update);
router.put("/:id/features", auth, role("SuperAdmin"), PlanController.setFeature);

module.exports = router;
