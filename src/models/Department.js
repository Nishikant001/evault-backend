const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Department = sequelize.define(
  "Department",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // DEPRECATED — legacy single global Plant link. The application no
    // longer writes to this column: it caused one tenant's plant
    // assignment to silently overwrite another tenant's, because Department
    // rows are shared (global master) across every tenant they're assigned
    // to. Retained only so old rows/reads keep working. All new plant
    // assignment logic uses the tenant-scoped TenantDepartmentPlant table —
    // see src/models/TenantDepartmentPlant.js for the full explanation.
    plantId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "plants", key: "id" },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: "Short unique code e.g. HR, FIN, OPS",
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      defaultValue: "ACTIVE",
    },

    // ── SAP Master Synchronization ─────────────────────────
    // The SAP DepartmentSet code this row was created/matched from.
    // Nullable: departments created manually in this app (not via sync)
    // simply have no SAP linkage. Unique so the sync engine can upsert by
    // this column without ever creating a duplicate department per SAP code.
    sapCode: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
      comment: "SAP DepartmentSet code — set by SAP Master Synchronization",
    },
    lastSyncedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "Last time this row was updated by SAP Master Synchronization",
    },
  },
  {
    tableName: "departments",
    timestamps: true,
  }
);

module.exports = Department;