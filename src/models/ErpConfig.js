const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ErpConfig = sequelize.define(
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

    baseUrl: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    username: {
      type: DataTypes.STRING,
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