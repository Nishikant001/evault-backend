// Additive + idempotent: creates biometric_devices only if absent. Never touches
// existing tables or data. New tenants already get this table from the sync() in
// 20260813000001-create-tenant-schema.js (the model is in the factory), so the
// existence check below simply skips for them.
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());
    if (tables.includes("biometric_devices")) return;
    await queryInterface.createTable("biometric_devices", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      userId: { type: Sequelize.INTEGER, allowNull: false },
      deviceId: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      secretHash: { type: Sequelize.STRING(64), allowNull: false },
      deviceLabel: { type: Sequelize.STRING(120), allowNull: true },
      platform: { type: Sequelize.STRING(20), allowNull: true },
      lastUsedAt: { type: Sequelize.DATE, allowNull: true },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      revokedAt: { type: Sequelize.DATE, allowNull: true },
      revokedReason: { type: Sequelize.STRING(60), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("biometric_devices", ["userId"]);
  },
  // Rollback: manual only (DROP TABLE biometric_devices), same policy as other tenant migrations.
  async down() { /* intentionally empty: never drop tenant data automatically */ },
};
