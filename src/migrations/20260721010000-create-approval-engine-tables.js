"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // ── approval_workflows ─────────────────────────────────────
    await queryInterface.createTable("approval_workflows", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
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
      categoryId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "categories", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      documentTypeId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "document_types", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      name: { type: Sequelize.STRING, allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      approvalMode: {
        type: Sequelize.ENUM("SEQUENTIAL", "PARALLEL"),
        allowNull: false,
        defaultValue: "SEQUENTIAL",
      },
      allowSelfApproval: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      status: {
        type: Sequelize.ENUM("ACTIVE", "INACTIVE"),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      createdBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      "approval_workflows",
      ["tenantId", "departmentId", "categoryId", "documentTypeId"],
      { unique: true, name: "unique_workflow_per_tenant_combo" }
    );

    // ── approval_levels ─────────────────────────────────────────
    await queryInterface.createTable("approval_levels", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      approvalWorkflowId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "approval_workflows", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      levelNumber: { type: Sequelize.INTEGER, allowNull: false },
      name: { type: Sequelize.STRING, allowNull: false },
      isParallel: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      status: {
        type: Sequelize.ENUM("ACTIVE", "INACTIVE"),
        allowNull: false,
        defaultValue: "ACTIVE",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
      "approval_levels",
      ["approvalWorkflowId", "levelNumber"],
      { unique: true, name: "unique_level_per_workflow" }
    );

    // ── approval_assignments ─────────────────────────────────────
    await queryInterface.createTable("approval_assignments", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      approvalLevelId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "approval_levels", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      approverType: {
        type: Sequelize.ENUM("ROLE", "USER", "DESIGNATION", "DEPARTMENT"),
        allowNull: false,
      },
      approverRole: { type: Sequelize.STRING, allowNull: true },
      approverUserId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      approverDepartmentId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "departments", key: "id" },
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
    await queryInterface.addIndex("approval_assignments", ["approvalLevelId"], {
      name: "idx_assignment_level",
    });

    // ── document_approvals ───────────────────────────────────────
    await queryInterface.createTable("document_approvals", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      documentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: "documents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      approvalWorkflowId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "approval_workflows", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      tenantId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tenants", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      currentLevel: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      totalLevels: { type: Sequelize.INTEGER, allowNull: false },
      status: {
        type: Sequelize.ENUM(
          "SUBMITTED",
          "PENDING_APPROVAL",
          "PARTIALLY_APPROVED",
          "APPROVED",
          "REJECTED",
          "SENT_BACK",
          "CANCELLED",
          "COMPLETED"
        ),
        allowNull: false,
        defaultValue: "SUBMITTED",
      },
      submittedBy: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      submittedAt: { type: Sequelize.DATE, allowNull: true },
      completedAt: { type: Sequelize.DATE, allowNull: true },
      rejectedBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      rejectedAt: { type: Sequelize.DATE, allowNull: true },
      rejectReason: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("document_approvals", ["tenantId"], {
      name: "idx_doc_approval_tenant",
    });
    await queryInterface.addIndex("document_approvals", ["status"], {
      name: "idx_doc_approval_status",
    });
    await queryInterface.addIndex("document_approvals", ["approvalWorkflowId"], {
      name: "idx_doc_approval_workflow",
    });

    // ── approval_history ──────────────────────────────────────────
    await queryInterface.createTable("approval_history", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      documentApprovalId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "document_approvals", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      documentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "documents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      levelNumber: { type: Sequelize.INTEGER, allowNull: true },
      action: {
        type: Sequelize.ENUM(
          "SUBMIT",
          "APPROVE",
          "REJECT",
          "SEND_BACK",
          "CANCEL",
          "RESUBMIT",
          "SKIP",
          "DELEGATE"
        ),
        allowNull: false,
      },
      actionBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      actionByName: { type: Sequelize.STRING, allowNull: true },
      actionByRole: { type: Sequelize.STRING, allowNull: true },
      oldStatus: { type: Sequelize.STRING, allowNull: true },
      newStatus: { type: Sequelize.STRING, allowNull: true },
      comments: { type: Sequelize.TEXT, allowNull: true },
      rejectReason: { type: Sequelize.TEXT, allowNull: true },
      ipAddress: { type: Sequelize.STRING, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("approval_history", ["documentApprovalId"], {
      name: "idx_history_doc_approval",
    });
    await queryInterface.addIndex("approval_history", ["documentId"], {
      name: "idx_history_document",
    });
    await queryInterface.addIndex("approval_history", ["action"], {
      name: "idx_history_action",
    });

    // ── approval_comments ────────────────────────────────────────
    await queryInterface.createTable("approval_comments", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      documentApprovalId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "document_approvals", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      levelNumber: { type: Sequelize.INTEGER, allowNull: true },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      comment: { type: Sequelize.TEXT, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("approval_comments", ["documentApprovalId"], {
      name: "idx_comment_doc_approval",
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable("approval_comments");
    await queryInterface.dropTable("approval_history");
    await queryInterface.dropTable("document_approvals");
    await queryInterface.dropTable("approval_assignments");
    await queryInterface.dropTable("approval_levels");
    await queryInterface.dropTable("approval_workflows");
  },
};
