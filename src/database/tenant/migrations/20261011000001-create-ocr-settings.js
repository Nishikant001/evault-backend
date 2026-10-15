// Additive + idempotent: creates ocr_settings only if absent. Never touches
// existing tables or data. No down() data loss: down is intentionally a no-op.
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());
    if (tables.includes("ocr_settings")) return;
    await queryInterface.createTable("ocr_settings", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: { type: Sequelize.INTEGER, allowNull: false, unique: true },
      engineMode: { type: Sequelize.ENUM("TESSERACT", "LICENSED"), allowNull: false, defaultValue: "TESSERACT" },
      provider: { type: Sequelize.STRING(50), allowNull: true },
      isProviderEnabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      fallbackToTesseract: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      providerConfigJson: { type: Sequelize.JSON, allowNull: true },
      credentialsEncrypted: { type: Sequelize.TEXT("long"), allowNull: true },
      credentialsUpdatedAt: { type: Sequelize.DATE, allowNull: true },
      lastTestStatus: { type: Sequelize.STRING(40), allowNull: true },
      lastTestMessage: { type: Sequelize.STRING(500), allowNull: true },
      lastTestAt: { type: Sequelize.DATE, allowNull: true },
      lastSuccessfulTestAt: { type: Sequelize.DATE, allowNull: true },
      updatedBy: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },
  async down() { /* intentionally empty: never drop tenant data automatically */ },
};
