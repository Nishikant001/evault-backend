// src/constants/assignmentConstants.js
//
// Central vocabulary for the Dynamic User Assignment Engine.
// Mirrors the pattern used in auditActions.js (shared constants instead of
// free-text strings scattered across controllers/services).

const ASSIGNMENT_LEVELS = {
  DEPARTMENT: "DEPARTMENT",
  CATEGORY: "CATEGORY",
  DOCUMENT_TYPE: "DOCUMENT_TYPE",
};

const ASSIGNMENT_STATUS = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
};

module.exports = {
  ASSIGNMENT_LEVELS,
  ASSIGNMENT_STATUS,
};
