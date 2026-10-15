// src/models/tenantModels/OcrSettings.js
// One row per tenant database. Lives in the TENANT DB (database-per-tenant), so
// credentials are physically isolated per tenant. Master-level entitlement is
// the separate `licensed_ocr` system module (master DB).
const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "OcrSettings",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    engineMode: { type: DataTypes.ENUM("TESSERACT", "LICENSED"), allowNull: false, defaultValue: "TESSERACT" },
    provider: { type: DataTypes.STRING(50), allowNull: true },
    isProviderEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    fallbackToTesseract: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    providerConfigJson: { type: DataTypes.JSON, allowNull: true, comment: "Non-secret provider settings (projectId, location, processorId)" },
    credentialsEncrypted: { type: DataTypes.TEXT("long"), allowNull: true, comment: "AES-256-GCM ciphertext (credentialVault); never serialised to clients" },
    credentialsUpdatedAt: { type: DataTypes.DATE, allowNull: true },
    lastTestStatus: { type: DataTypes.STRING(40), allowNull: true },
    lastTestMessage: { type: DataTypes.STRING(500), allowNull: true },
    lastTestAt: { type: DataTypes.DATE, allowNull: true },
    lastSuccessfulTestAt: { type: DataTypes.DATE, allowNull: true },
    updatedBy: { type: DataTypes.INTEGER, allowNull: true },
  },
  { tableName: "ocr_settings", timestamps: true }
);
