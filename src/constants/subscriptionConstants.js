// src/constants/subscriptionConstants.js
//
// Canonical feature keys used by PlanFeature rows and subscriptionMiddleware.
// Add a new key here + a row per plan in seeders/planSeeder.js when a new
// gated capability is introduced — never hardcode a plan-name check in
// business logic.

const FEATURE_KEYS = {
  SAP_SYNC: "SAP_SYNC",              // SAP upload/download/retrieval/metadata/master sync
  AI_ASSISTANT: "AI_ASSISTANT",      // umbrella flag for the AI Document Assistant module
  AI_CHAT: "AI_CHAT",                // RAG chat sessions
  AI_SEARCH: "AI_SEARCH",            // semantic/metadata/OCR AI search
  VECTOR_SEARCH: "VECTOR_SEARCH",    // embeddings/vector store indexing
  OCR: "OCR",
  APPROVAL_WORKFLOW: "APPROVAL_WORKFLOW",
  SEARCH: "SEARCH",
  METADATA: "METADATA",
  ANALYTICS: "ANALYTICS",
  REPORTS: "REPORTS",
  WATERMARK: "WATERMARK",            // informational flag; actual gate is Tenant.tenantType
  NOTIFICATIONS: "NOTIFICATIONS",
};

const TENANT_TYPES = { FREE: "FREE", PAID: "PAID" };

const SUBSCRIPTION_STATUS = {
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  SUSPENDED: "SUSPENDED",
  CANCELLED: "CANCELLED",
};

const PLAN_CODES = { FREE: "FREE", PAID: "PAID" };

const FREE_TRIAL_DURATION_DAYS = 30;

// Task 4 — Daily Upload Limit: FREE tenants may upload at most this many
// documents per calendar day (UTC). Enforced by
// subscriptionMiddleware.enforceDailyUploadLimit against the `documents`
// table (createdAt), so the count survives restarts and resets naturally
// at UTC midnight — no in-memory counters, nothing to reset manually.
const FREE_DAILY_UPLOAD_LIMIT = 5;

// Features a FREE tenant gets, per the product requirement.
const FREE_PLAN_FEATURES = [
  FEATURE_KEYS.OCR,
  FEATURE_KEYS.METADATA,
  FEATURE_KEYS.SEARCH,
  FEATURE_KEYS.APPROVAL_WORKFLOW,
  FEATURE_KEYS.NOTIFICATIONS,
  // WATERMARK is enabled for FREE (informational — real enforcement is
  // Tenant.tenantType === 'FREE' in documentController).
  FEATURE_KEYS.WATERMARK,
];

// Every feature key is enabled for PAID (today's unchanged behavior).
const PAID_PLAN_FEATURES = Object.values(FEATURE_KEYS).filter(
  (k) => k !== FEATURE_KEYS.WATERMARK,
);

module.exports = {
  FEATURE_KEYS,
  TENANT_TYPES,
  SUBSCRIPTION_STATUS,
  PLAN_CODES,
  FREE_TRIAL_DURATION_DAYS,
  FREE_DAILY_UPLOAD_LIMIT,
  FREE_PLAN_FEATURES,
  PAID_PLAN_FEATURES,
};
