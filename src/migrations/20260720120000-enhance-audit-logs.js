"use strict";

// ─────────────────────────────────────────────────────────────
// Enhance audit_logs for the Enterprise Audit Trail System.
// Only ADDS new nullable columns + indexes — never touches or drops any
// existing column, so existing audit rows and existing code that reads
// action/module/userId/details/tenantId/ipAddress keep working unchanged.
// ─────────────────────────────────────────────────────────────
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable("audit_logs");

    const addColumnIfMissing = async (name, definition) => {
      if (!table[name]) {
        await queryInterface.addColumn("audit_logs", name, definition);
      }
    };

    await addColumnIfMissing("username", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing("role", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing("department", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing("oldValue", {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await addColumnIfMissing("newValue", {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await addColumnIfMissing("documentId", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing("sapDocumentId", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing("browser", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing("device", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing("operatingSystem", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing("remarks", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await addColumnIfMissing("status", {
      type: Sequelize.ENUM("SUCCESS", "FAILED", "PENDING"),
      allowNull: false,
      defaultValue: "SUCCESS",
    });

    // Helpful indexes for filtering / searching large audit tables.
    const addIndexSafe = async (fields, name) => {
      try {
        await queryInterface.addIndex("audit_logs", fields, { name });
      } catch (e) {
        // Index likely already exists — safe to ignore in re-runs.
      }
    };

    await addIndexSafe(["tenantId"], "idx_audit_logs_tenantId");
    await addIndexSafe(["userId"], "idx_audit_logs_userId");
    await addIndexSafe(["module"], "idx_audit_logs_module");
    await addIndexSafe(["action"], "idx_audit_logs_action");
    await addIndexSafe(["documentId"], "idx_audit_logs_documentId");
    await addIndexSafe(["status"], "idx_audit_logs_status");
    await addIndexSafe(["createdAt"], "idx_audit_logs_createdAt");
  },

  down: async (queryInterface) => {
    const removeColumnSafe = async (name) => {
      try {
        await queryInterface.removeColumn("audit_logs", name);
      } catch (e) {
        // Column may not exist — safe to ignore.
      }
    };

    await removeColumnSafe("username");
    await removeColumnSafe("role");
    await removeColumnSafe("department");
    await removeColumnSafe("oldValue");
    await removeColumnSafe("newValue");
    await removeColumnSafe("documentId");
    await removeColumnSafe("sapDocumentId");
    await removeColumnSafe("browser");
    await removeColumnSafe("device");
    await removeColumnSafe("operatingSystem");
    await removeColumnSafe("remarks");
    await removeColumnSafe("status");
  },
};
