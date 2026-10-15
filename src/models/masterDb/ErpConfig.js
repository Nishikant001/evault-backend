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
const {
  PROTOCOLS,
  AUTH_TYPES,
  normalizeErpType,
} = require("../../services/connector/connectorSchema");

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

    // DYNAMIC ERP CONNECTOR (Step 1): was ENUM("SAP","ORACLE","CUSTOM").
    // Now free text (e.g. SAP, ORACLE, ODOO, NETSUITE, MY_ERP) so adding
    // an ERP never needs a schema change. Always stored UPPER_SNAKE_CASE.
    erpType: {
      type: DataTypes.STRING(50),
      allowNull: false,
      set(value) {
        this.setDataValue("erpType", normalizeErpType(value) || value);
      },
      validate: {
        isValidErpType(value) {
          if (!normalizeErpType(value)) {
            throw new Error(
              "erpType must be 2-50 characters: letters, digits or underscore, starting with a letter",
            );
          }
        },
      },
    },

    // How the generic connector engine talks to this ERP.
    // SAP rows use the dedicated SAP OData engine and ignore connectorConfig.
    protocol: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "REST",
      validate: { isIn: [PROTOCOLS] },
    },

    // Declarative connector description (see services/connector/connectorSchema.js).
    // NEVER holds secrets — those stay in the encrypted columns below.
    connectorConfig: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    // Which template this ERP was created from (informational).
    templateKey: {
      type: DataTypes.STRING(100),
      allowNull: true,
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

    // Was ENUM("BASIC","BEARER","API_KEY"); now also NONE and
    // OAUTH2_CLIENT_CREDENTIALS (client id -> username, secret -> password).
    authType: {
      type: DataTypes.STRING(30),
      defaultValue: "BASIC",
      validate: { isIn: [AUTH_TYPES] },
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