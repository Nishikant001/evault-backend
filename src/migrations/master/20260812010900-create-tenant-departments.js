"use strict";

// MASTER DB migration. Written from src/models/masterDb/TenantDepartment.js.
// Real FK constraints to `tenants` and `departments` — both now genuinely
// live in this same physical database, so unlike TenantDepartmentPlant's
// reference to this table (a cross-database, non-enforced reference from
// the Tenant DB — see that model's comments), these ARE real, enforced
// foreign keys.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("tenant_departments", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onDelete: "CASCADE",
      },
      departmentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "departments", key: "id" },
        onDelete: "CASCADE",
      },
      assignedBy: { type: Sequelize.INTEGER, allowNull: true },
      status: { type: Sequelize.ENUM("ACTIVE", "INACTIVE"), defaultValue: "ACTIVE" },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("tenant_departments", ["tenantId", "departmentId"], {
      unique: true,
      name: "tenant_departments_tenant_id_department_id_unique",
    });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable("tenant_departments");
  },
};
