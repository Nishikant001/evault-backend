"use strict";

const MODULES = [
  ["dms", "Document Management", "Core document repository and document operations.", "folder", "documents"],
  ["workflow", "Workflow", "Document upload, workflow and approvals.", "workflow", "workflow"],
  ["audit", "Audit", "Audit log and audit history.", "audit", "audit"],
  ["communication", "Communication", "Internal tenant communication and chat.", "communication", "communication"],
  ["ai_assistant", "AI Assistant", "AI chat, search and document intelligence.", "aiAssistant", "aiChat"],
  ["metadata_engine", "Metadata Engine", "Dynamic OCR metadata templates and fields.", "metadataTemplate", "metadataTemplates"],
  ["approval_engine", "Approval Engine", "Approval workflows, assignments and actions.", "approvalCheck", "approvals"],
  ["cross_department", "Cross Department Access", "Cross-department document access requests.", "shield", "crossDepartmentRequest"],
  ["sap_sync", "SAP Synchronization", "ERP/SAP master and document synchronization.", "sapSync", "SAP_SYNC_DASHBOARD"],
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    await queryInterface.createTable("system_modules", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      moduleKey: { type: Sequelize.STRING(100), allowNull: false, unique: true },
      moduleName: { type: Sequelize.STRING(150), allowNull: false },
      description: { type: Sequelize.STRING(500), allowNull: true },
      icon: { type: Sequelize.STRING(100), allowNull: true },
      routeKey: { type: Sequelize.STRING(150), allowNull: true },
      isDefault: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable("tenant_modules", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE", onDelete: "CASCADE",
      },
      moduleId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: "system_modules", key: "id" },
        onUpdate: "CASCADE", onDelete: "CASCADE",
      },
      isEnabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      assignedBy: { type: Sequelize.INTEGER, allowNull: true },
      assignedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("tenant_modules", ["tenantId", "moduleId"], { unique: true, name: "tenant_modules_tenant_module_unique" });
    await queryInterface.addIndex("tenant_modules", ["tenantId"], { name: "tenant_modules_tenant_idx" });
    await queryInterface.addIndex("tenant_modules", ["moduleId"], { name: "tenant_modules_module_idx" });

    for (const [moduleKey, moduleName, description, icon, routeKey] of MODULES) {
      await queryInterface.bulkInsert("system_modules", [{ moduleKey, moduleName, description, icon, routeKey, isDefault: true, isActive: true, createdAt: now, updatedAt: now }]);
    }

    // Preserve existing functionality: every existing tenant receives all
    // currently implemented modules. Future optional modules are assigned
    // explicitly by SuperAdmin instead of being granted by the frontend.
    const tenants = await queryInterface.sequelize.query("SELECT id FROM tenants", { type: Sequelize.QueryTypes.SELECT });
    const modules = await queryInterface.sequelize.query("SELECT id FROM system_modules WHERE isDefault = 1", { type: Sequelize.QueryTypes.SELECT });
    const rows = [];
    for (const tenant of tenants) {
      for (const module of modules) {
        rows.push({ tenantId: tenant.id, moduleId: module.id, isEnabled: true, assignedBy: null, assignedAt: now, createdAt: now, updatedAt: now });
      }
    }
    if (rows.length) await queryInterface.bulkInsert("tenant_modules", rows);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("tenant_modules");
    await queryInterface.dropTable("system_modules");
  },
};
