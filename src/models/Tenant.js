const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Tenant = sequelize.define(
  "Tenant",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    tenantName: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    tenantCode: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
    },
    erpConfigId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
      allowNull: false,
      defaultValue: "ACTIVE",
    },

    // ── Subscription Management System ──────────────────────────────
    // See migrations/20260803010000-add-tenant-type-to-tenants.js.
    // Default 'PAID' means every tenant that existed before this feature
    // keeps its current behavior automatically. Only new FREE self-service
    // registrations (subscriptionController) set this to 'FREE'. This flag
    // drives the couple of hard-wired rules (no SAP calls, local-only
    // storage, watermarked documents); everything else is feature-flag
    // driven via Plan/PlanFeature (see subscriptionMiddleware.js).
    tenantType: {
      type: DataTypes.ENUM("FREE", "PAID"),
      allowNull: false,
      defaultValue: "PAID",
    },

    // ── Frontend metadata-driven terminology/hierarchy ──────────────
    // See migrations/20260723020000-add-metadata-to-tenants.js and
    // constants/tenantMetadataDefaults.js for the full explanation and
    // the fallback used when this is null.
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },

  {
    tableName: "tenants",
    timestamps: true,
  },
);

module.exports = Tenant;
