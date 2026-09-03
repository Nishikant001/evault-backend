// src/models/tenantModels/CommunicationVoiceMessage.js
// MERGE — factory version. See CommunicationConversation.js header for
// the general rationale.
//
// Metadata for a VOICE CommunicationMessage. Binary audio is never stored
// in MySQL — `storageKey` is an opaque, server-generated identifier
// resolved by CommunicationVoiceStorageService. storageProvider is kept
// generic ("local" today) so a later move to S3/object storage is a
// service-layer change only, not a schema or controller change.

const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "CommunicationVoiceMessage",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    messageId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "communication_messages", key: "id" },
    },
    storageProvider: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "local",
    },
    storageKey: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "Opaque server-generated identifier — never a raw filesystem path, never trusts the original filename",
    },
    mimeType: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    fileSize: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "Bytes",
    },
    durationSeconds: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    waveformJson: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Optional JSON array of amplitude samples for waveform UI",
    },
  },
  {
    tableName: "communication_voice_messages",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["tenantId"] },
      { fields: ["messageId"] },
    ],
  }
);
