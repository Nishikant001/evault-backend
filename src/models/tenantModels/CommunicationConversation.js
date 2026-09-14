// src/models/tenantModels/CommunicationConversation.js
// MERGE — factory version for the tenant-aware architecture. Exports a
// function (sequelize) => Model, so this can be instantiated against ANY
// tenant's Sequelize connection instead of a single shared singleton.
// Field definitions are unchanged from the communication backend's
// src/models/CommunicationConversation.js — only the require/export
// wrapper differs, and the `tenantId`/`participantAId`/`participantBId`
// columns no longer carry a cross-database `references` (Tenant lives in
// the Master DB; a live FK across two physical databases isn't possible
// — see tenantModels/index.js header comment). participantA/B still
// reference `users`, which IS a tenant-local table, so that FK is kept.
//
// A conversation between users of the SAME tenant — either DIRECT
// (exactly two participants) or GROUP (three or more, with a name).
//
// `participantAId` / `participantBId` are only meaningful for DIRECT
// conversations (always stored with the smaller userId in slot A — see
// communicationService.buildParticipantPair) so a unique index on
// (tenantId, participantAId, participantBId) prevents ever creating two
// DIRECT conversations between the same two users. GROUP rows leave both
// null — MySQL treats multiple NULLs in a unique index as distinct, so
// this doesn't collide with any other GROUP conversation.

const { DataTypes } = require("sequelize");

module.exports = (sequelize) => sequelize.define(
  "CommunicationConversation",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tenantId: {
      // Plain integer — Tenant lives in the Master DB, no live association.
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM("DIRECT", "GROUP"),
      allowNull: false,
      defaultValue: "DIRECT",
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: true,
      comment: "GROUP conversations only — DIRECT conversations derive their display name from the other participant",
    },
    participantAId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    participantBId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
      comment: "For GROUP conversations, also the group admin — the only user who can rename the group or remove other members",
    },
    lastMessageId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    lastMessageAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lastMessagePreview: {
      type: DataTypes.STRING(180),
      allowNull: true,
      comment: "Denormalized short preview for the conversation list — avoids a join on every list render",
    },
  },
  {
    tableName: "communication_conversations",
    timestamps: true,
    indexes: [
      { fields: ["tenantId"] },
      { fields: ["tenantId", "lastMessageAt"] },
      {
        unique: true,
        fields: ["tenantId", "participantAId", "participantBId"],
        name: "unique_direct_conversation_per_tenant",
      },
    ],
  }
);
