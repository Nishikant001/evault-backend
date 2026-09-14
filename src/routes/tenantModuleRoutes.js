const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const Controller = require("../controllers/tenantModuleController");

router.get("/my-modules", auth, Controller.myModules);
router.get("/", auth, role("SuperAdmin"), Controller.list);
router.post("/", auth, role("SuperAdmin"), Controller.create);
router.put("/:id", auth, role("SuperAdmin"), Controller.update);
router.get("/tenants/:tenantId", auth, role("SuperAdmin"), Controller.tenantAssignments);
router.post("/tenants/:tenantId/:moduleId", auth, role("SuperAdmin"), Controller.assign);
router.delete("/tenants/:tenantId/:moduleId", auth, role("SuperAdmin"), Controller.unassign);
router.patch("/tenants/:tenantId/:moduleId", auth, role("SuperAdmin"), Controller.setEnabled);

module.exports = router;
