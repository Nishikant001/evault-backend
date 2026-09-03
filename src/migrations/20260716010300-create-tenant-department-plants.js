"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("tenant_department_plants", {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      tenantDepartmentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenant_departments", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      departmentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "departments", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      plantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "plants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      companyCodeId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "company_codes", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      assignedBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM("ACTIVE", "INACTIVE"),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex(
      "tenant_department_plants",
      ["tenantId", "departmentId", "plantId"],
      {
        unique: true,
        name: "unique_tenant_department_plant",
      }
    );
    await queryInterface.addIndex("tenant_department_plants", ["tenantId"], {
      name: "idx_tdp_tenant",
    });
    await queryInterface.addIndex("tenant_department_plants", ["plantId"], {
      name: "idx_tdp_plant",
    });
    await queryInterface.addIndex(
      "tenant_department_plants",
      ["departmentId"],
      { name: "idx_tdp_department" }
    );
    await queryInterface.addIndex(
      "tenant_department_plants",
      ["companyCodeId"],
      { name: "idx_tdp_company_code" }
    );

    // ── Best-effort backfill ─────────────────────────────────────
    // Previously a Department could carry a single global `plantId`.
    // For any Department that already had a plantId set, create an
    // equivalent tenant-scoped mapping row for every tenant that Department
    // is/was assigned to, so no existing plant assignment is silently lost
    // when this migration runs. Going forward, `departments.plantId` is no
    // longer written to by the application — it is retained purely for
    // historical/backward-compatibility read access.
    const [rows] = await queryInterface.sequelize.query(`
      SELECT td.id AS tenantDepartmentId,
             td.tenantId AS tenantId,
             d.id AS departmentId,
             d.plantId AS plantId,
             p.companyCodeId AS companyCodeId
      FROM departments d
      INNER JOIN tenant_departments td ON td.departmentId = d.id AND td.status = 'ACTIVE'
      INNER JOIN plants p ON p.id = d.plantId
      WHERE d.plantId IS NOT NULL
    `);

    if (rows && rows.length > 0) {
      const now = new Date();
      const records = rows.map((r) => ({
        tenantDepartmentId: r.tenantDepartmentId,
        tenantId: r.tenantId,
        departmentId: r.departmentId,
        plantId: r.plantId,
        companyCodeId: r.companyCodeId,
        assignedBy: null,
        status: "ACTIVE",
        createdAt: now,
        updatedAt: now,
      }));

      await queryInterface.bulkInsert(
        "tenant_department_plants",
        records,
        { ignoreDuplicates: true }
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("tenant_department_plants");
  },
};
