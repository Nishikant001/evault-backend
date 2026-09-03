// src/models/tenantModels/CommunicationCallSession.js
// MERGE — factory version. See CommunicationConversation.js header for
// the general rationale.
//
// One row per 1-to-1 audio/video call attempt within a
// CommunicationConversation. The row is created the moment the caller's
// invite is accepted-for-ringing by the server (status RINGING) and
// updated in place as the call progresses — never re-created for the
// same attempt. Real-time signalling (offer/answer/ICE) itself is never
// persisted here or anywhere else; only the call's lifecycle/outcome is.

const { DataTypes } = require("sequelize");
const { CALL_TYPES, CALL_STATUS } = require("../../constants/communicationConstants");

module.exports = (sequelize) => sequelize.define(
  "CommunicationCallSession",
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
    callerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
    },
    calleeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
    },
    callType: {
      type: DataTypes.ENUM(...Object.values(CALL_TYPES)),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(CALL_STATUS)),
      allowNull: false,
      defaultValue: CALL_STATUS.RINGING,
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: "When the invite was created (ringing began)",
    },
    connectedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When both sides completed WebRTC negotiation, if ever",
    },
    endedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    durationSeconds: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Only meaningful once connectedAt is set — time actually connected, not total ring+talk time",
    },
  },
  {
    tableName: "communication_call_sessions",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["tenantId", "conversationId"] },
      { fields: ["callerId"] },
      { fields: ["calleeId"] },
    ],
  }
);
