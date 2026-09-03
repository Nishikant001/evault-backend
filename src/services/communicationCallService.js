// src/services/communicationCallService.js
//
// Persistence layer for call RECORDS only (CommunicationCallSession).
// All real-time signalling (invite/offer/answer/ICE) lives entirely in
// communicationSocketService.js's in-memory state — this service never
// sees SDP/ICE payloads, only lifecycle transitions worth keeping in
// MySQL for history/audit purposes.
//
// MERGE — tenant-aware rewrite: every method now takes `models` (the
// tenant-scoped model set) as its first parameter, exactly like
// communicationService.js. tenantId is still always passed in
// explicitly by the caller (the socket service, itself populated from
// the authenticated socket.user via getTenantConnection), never
// trusted from client payloads.

const { CALL_STATUS } = require("../constants/communicationConstants");

class CommunicationCallService {
  static async createRinging(models, { tenantId, conversationId, callerId, calleeId, callType }) {
    const { CommunicationCallSession } = models;
    return CommunicationCallSession.create({
      tenantId,
      conversationId,
      callerId,
      calleeId,
      callType,
      status: CALL_STATUS.RINGING,
      startedAt: new Date(),
    });
  }

  static async markConnecting(models, tenantId, callId) {
    const { CommunicationCallSession } = models;
    const call = await CommunicationCallSession.findOne({ where: { id: callId, tenantId } });
    if (!call) return null;
    call.status = CALL_STATUS.CONNECTING;
    await call.save();
    return call;
  }

  static async markConnected(models, tenantId, callId) {
    const { CommunicationCallSession } = models;
    const call = await CommunicationCallSession.findOne({ where: { id: callId, tenantId } });
    if (!call || call.connectedAt) return call; // idempotent — ICE can "connect" more than once
    call.status = CALL_STATUS.CONNECTED;
    call.connectedAt = new Date();
    await call.save();
    return call;
  }

  /** Terminal transition — the only place `endedAt`/`durationSeconds` are
   * set. Safe to call more than once for the same call (idempotent). */
  static async finalize(models, tenantId, callId, status) {
    const { CommunicationCallSession } = models;
    const call = await CommunicationCallSession.findOne({ where: { id: callId, tenantId } });
    if (!call || call.endedAt) return call;
    call.status = status;
    call.endedAt = new Date();
    if (call.connectedAt) {
      call.durationSeconds = Math.max(0, Math.round((call.endedAt - call.connectedAt) / 1000));
    }
    await call.save();
    return call;
  }

  static async getById(models, tenantId, callId) {
    const { CommunicationCallSession } = models;
    return CommunicationCallSession.findOne({ where: { id: callId, tenantId } });
  }
}

module.exports = CommunicationCallService;
