// src/constants/approvalConstants.js
//
// Shared vocabulary for the Dynamic Approval Workflow Engine. Kept as
// constants (mirrors the pattern already used in constants/auditActions.js)
// so controllers, services, and the frontend Matrix Builder all agree on
// the same set of values.

const APPROVER_TYPES = {
  ROLE: "ROLE",
  USER: "USER",
  DESIGNATION: "DESIGNATION",
  DEPARTMENT: "DEPARTMENT",
};

const APPROVAL_MODES = {
  SEQUENTIAL: "SEQUENTIAL",
  PARALLEL: "PARALLEL", // future-ready, not yet executed by the engine
};

const DOCUMENT_APPROVAL_STATUS = {
  SUBMITTED: "SUBMITTED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  PARTIALLY_APPROVED: "PARTIALLY_APPROVED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  SENT_BACK: "SENT_BACK",
  CANCELLED: "CANCELLED",
  COMPLETED: "COMPLETED",
};

// Terminal states — no further approval action can be taken once a
// DocumentApproval reaches one of these (except RESUBMIT from SENT_BACK
// and REJECTED, which is handled explicitly by the engine).
const TERMINAL_STATUSES = [
  DOCUMENT_APPROVAL_STATUS.CANCELLED,
  DOCUMENT_APPROVAL_STATUS.COMPLETED,
];

const APPROVAL_ACTIONS = {
  SUBMIT: "SUBMIT",
  APPROVE: "APPROVE",
  REJECT: "REJECT",
  SEND_BACK: "SEND_BACK",
  CANCEL: "CANCEL",
  RESUBMIT: "RESUBMIT",
  SKIP: "SKIP", // future — not exposed via API yet
  DELEGATE: "DELEGATE", // future — not exposed via API yet
};

// Notification hook event names. No email/SMS implementation — these are
// fired through NotificationHookService as log-only hooks that a future
// notification channel can subscribe to.
const APPROVAL_EVENTS = {
  SUBMITTED: "APPROVAL_SUBMITTED",
  PENDING_APPROVAL: "APPROVAL_PENDING",
  APPROVED: "APPROVAL_APPROVED",
  REJECTED: "APPROVAL_REJECTED",
  SENT_BACK: "APPROVAL_SENT_BACK",
  CANCELLED: "APPROVAL_CANCELLED",
  COMPLETED: "APPROVAL_COMPLETED",
};

module.exports = {
  APPROVER_TYPES,
  APPROVAL_MODES,
  DOCUMENT_APPROVAL_STATUS,
  TERMINAL_STATUSES,
  APPROVAL_ACTIONS,
  APPROVAL_EVENTS,
};
