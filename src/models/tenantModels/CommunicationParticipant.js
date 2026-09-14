// src/models/tenantModels/CommunicationParticipant.js
// MERGE — factory version. See CommunicationConversation.js header for
// the general rationale (tenantId is now a plain integer, no cross-DB
// reference; intra-tenant FKs to `users`/`communication_conversations`
// are kept as-is since both live in the same tenant database).
//
// One row per (conversation, user). Drives per-user read state, mute and
// archive — kept separate from CommunicationConversation so read state is
// tracked independently for each side of the chat.

const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "CommunicationParticipant",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    conversationId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "communication_conversations", key: "id" },
    },
    tenantId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
    },
    joinedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    lastReadMessageId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    lastReadAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    mutedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    archivedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    leftAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "GROUP conversations only — set when a member leaves or is removed; row is kept (not deleted) so message history/attribution stays intact",
    },
  },
  {
    tableName: "communication_participants",
    timestamps: true,
    indexes: [
      { fields: ["tenantId"] },
      { fields: ["userId"] },
      { fields: ["conversationId"] },
      { fields: ["tenantId", "userId"] },
      {
        unique: true,
        fields: ["conversationId", "userId"],
        name: "unique_participant_per_conversation",
      },
    ],
  }
);
