// src/models/masterDb/ErpConfig.js
//
// PHASE B — moved here: ErpConfig has NO tenantId column at all (confirmed
// by grep across the model + erpConfigController.js), and the association
// is ErpConfig.hasMany(Tenant) — i.e. ONE ErpConfig (a SAP/ERP landscape
// definition) can be assigned to MANY tenants via Tenant.erpConfigId.
// That is shared platform configuration a SuperAdmin manages, same tier
// as Department/Plan, not tenant-owned operational data.
//
// Field-for-field identical to legacy src/models/ErpConfig.js.
const { DataTypes } = require("sequelize");
const masterSequelize = require("../../config/masterDatabase");

const ErpConfig = masterSequelize.define(
  "ErpConfig",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sapClient: {
      type: DataTypes.STRING,
      defaultValue: "100",
    },

    description: {
      type: DataTypes.STRING,
    },

    // ✅ FIX: there were two `status` keys in this object before.
    // In a JS object literal the second one silently wins, so the
    // real DB column ended up as ENUM("ACTIVE","INACTIVE") with a
    // default of "ACTIVE" — even though testConnection() tries to
    // write "CONNECTED"/"FAILED"/"PENDING", which aren't valid
    // values for that enum and would fail or get coerced. This is
    // the single status field now, matching what the controller
    // and frontend actually use.
    status: {
      type: DataTypes.ENUM(
        "PENDING",
        "CONNECTED",
        "FAILED",
        "INACTIVE",
        "ACTIVE"
      ),
      defaultValue: "PENDING",
    },

    isDefault: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    erpType: {
      type: DataTypes.ENUM("SAP", "ORACLE", "CUSTOM"),
      allowNull: false,
    },

    // Outbound Evault -> ERP endpoint. Nullable for inbound-only SAP integrations.
    baseUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    // Controls which integration directions are enabled for this configuration.
    integrationMode: {
      type: DataTypes.ENUM("INBOUND", "OUTBOUND", "BOTH"),
      allowNull: false,
      defaultValue: "BOTH",
    },

    // Outbound Evault -> ERP credentials.
    username: {
      type: DataTypes.STRING,
    },

    // Inbound SAP -> Evault credentials. Stored encrypted and never returned.
    inboundUsername: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    inboundPassword: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    password: {
      type: DataTypes.STRING,
    },

    authType: {
      type: DataTypes.ENUM("BASIC", "BEARER", "API_KEY"),
      defaultValue: "BASIC",
    },

    apiKey: {
      type: DataTypes.TEXT,
    },

    // ── Dynamic multi-tenant SAP mapping (metadata-driven integration) ──
    // See src/services/sapEntityResolver.js and src/services/sapMetadataService.js.
    // All nullable — a tenant that leaves these empty gets exactly today's
    // hardcoded Golyan behavior via the fallback constants in
    // constants/sapSyncConstants.js.
    metadataUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    odataVersion: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "v2",
    },

    entitySetMap: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    fieldMap: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    functionMap: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    metadataSnapshot: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    metadataFetchedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "erp_configs",
    timestamps: true,
  },
);

module.exports = ErpConfig;