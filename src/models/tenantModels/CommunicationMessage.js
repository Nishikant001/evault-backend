// src/models/tenantModels/CommunicationMessage.js
// MERGE — factory version. See CommunicationConversation.js header for
// the general rationale.
//
// One row per message (TEXT / VOICE / FILE / SYSTEM) inside a
// CommunicationConversation. Retention = FOREVER: deletion is always
// soft (deletedAt), never a hard DELETE, so history and audit trails
// stay intact.

const { DataTypes } = require("sequelize");
const { MESSAGE_TYPES } = require("../../constants/communicationConstants");

module.exports = (sequelize) => sequelize.define(
  "CommunicationMessage",
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
    conversationId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "communication_conversations", key: "id" },
    },
    senderId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
    },
    messageType: {
      type: DataTypes.ENUM(...Object.values(MESSAGE_TYPES)),
      allowNull: false,
      defaultValue: MESSAGE_TYPES.TEXT,
    },
    content: {
      // TEXT messages: the message body. VOICE messages: null (metadata
      // lives in CommunicationVoiceMessage). SYSTEM messages: a short
      // machine-generated string (e.g. "Conversation started").
      type: DataTypes.TEXT,
      allowNull: true,
    },
    replyToMessageId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "communication_messages", key: "id" },
    },
    deliveredAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "Set the moment the recipient's authenticated socket received the event",
    },
    editedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    deletedAt: {
      // Deliberately NOT Sequelize's `paranoid` soft-delete — we want the
      // row to keep rendering as "This message was deleted" rather than
      // disappear from queries entirely.
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "communication_messages",
    timestamps: true,
    indexes: [
      { fields: ["tenantId", "conversationId", "createdAt"] },
      { fields: ["senderId"] },
      { fields: ["replyToMessageId"] },
    ],
  }
);
