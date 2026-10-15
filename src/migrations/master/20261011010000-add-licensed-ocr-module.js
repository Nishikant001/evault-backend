"use strict";
// Registers the `licensed_ocr` system module. isDefault=false => NOT granted to
// any tenant (existing or new) until a Super Admin assigns it. Idempotent.
module.exports = {
  async up(queryInterface, Sequelize) {
    const [rows] = await queryInterface.sequelize.query("SELECT id FROM system_modules WHERE moduleKey = 'licensed_ocr' LIMIT 1");
    if (rows.length) return;
    const now = new Date();
    await queryInterface.bulkInsert("system_modules", [{
      moduleKey: "licensed_ocr", moduleName: "Licensed OCR Provider",
      description: "Use a licensed OCR provider (e.g. Google Cloud Document AI) configured by the Tenant Admin.",
      icon: "ocr", routeKey: "ocrSettings", isDefault: false, isActive: true, createdAt: now, updatedAt: now,
    }]);
  },
  // No down: removing the module would silently revoke tenant assignments.
  async down() {},
};
