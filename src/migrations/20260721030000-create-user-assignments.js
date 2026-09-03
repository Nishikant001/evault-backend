"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("user_assignments", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      departmentId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "departments", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      categoryId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "categories", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      documentTypeId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "document_types", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      assignmentLevel: {
        type: Sequelize.ENUM("DEPARTMENT", "CATEGORY", "DOCUMENT_TYPE"),
        allowNull: false,
      },
      assignedBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      status: {
        type: Sequelize.ENUM("ACTIVE", "INACTIVE"),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("user_assignments", ["tenantId", "userId"], {
      name: "idx_user_assignments_tenant_user",
    });
    await queryInterface.addIndex("user_assignments", ["tenantId", "userId", "departmentId"], {
      name: "idx_user_assignments_department",
    });
    await queryInterface.addIndex("user_assignments", ["tenantId", "userId", "categoryId"], {
      name: "idx_user_assignments_category",
    });
    await queryInterface.addIndex("user_assignments", ["tenantId", "userId", "documentTypeId"], {
      name: "idx_user_assignments_document_type",
    });
    await queryInterface.addIndex(
      "user_assignments",
      ["userId", "assignmentLevel", "departmentId", "categoryId", "documentTypeId"],
      { unique: true, name: "unique_user_assignment_target" }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("user_assignments");
  },
};
