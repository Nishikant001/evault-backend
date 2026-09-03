// src/models/tenantModels/CommunicationAttachment.js
// MERGE — factory version. See CommunicationConversation.js header for
// the general rationale.
//
// One row per uploaded file on a CommunicationMessage (a message can have
// zero or more — e.g. "here are the two contracts" in one message).
// Binary content is never stored in MySQL — `storageKey` is an opaque,
// server-generated identifier resolved by
// CommunicationAttachmentStorageService. storageProvider is kept generic
// ("local" today) so a later move to S3/object storage is a service-layer
// change only, not a schema or controller change.

const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "CommunicationAttachment",
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
    originalName: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "Client-supplied filename, display-only — never used to resolve a path",
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
    fileCategory: {
      type: DataTypes.ENUM("IMAGE", "PDF", "WORD", "EXCEL", "POWERPOINT", "TEXT", "ARCHIVE", "AUDIO", "VIDEO", "OTHER"),
      allowNull: false,
      defaultValue: "OTHER",
      comment: "Derived server-side from mimeType — drives which file-card icon/preview the frontend renders",
    },
    width: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Image attachments only, if known",
    },
    height: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Image attachments only, if known",
    },
    scanStatus: {
      type: DataTypes.ENUM("SKIPPED", "PENDING", "CLEAN", "INFECTED"),
      allowNull: false,
      defaultValue: "SKIPPED",
      comment:
        "Integration point for malware/virus scanning. SKIPPED = no scanner configured in this environment (honest default, not a false CLEAN claim). See communicationAttachmentStorageService.js for where a real scanner would hook in.",
    },
  },
  {
    tableName: "communication_attachments",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["tenantId"] },
      { fields: ["messageId"] },
    ],
  }
);
