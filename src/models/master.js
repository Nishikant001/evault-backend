// src/models/master.js
//
// COMPATIBILITY SHIM — added while completing Phase 5, NOT the real
// Phase 1 "Master DB Foundation".
//
// The Phase 5 reference conversion (tenantController.js, planController.js,
// and now otpService.js/subscriptionService.js/subscriptionMiddleware.js)
// was written assuming a genuine master/tenant DB split: a separate master
// Sequelize connection for platform-level data (Tenant, Plan, Subscription,
// OtpVerification, ...) and separate per-tenant physical databases for
// everything else, resolved per-request via a tenant connection manager.
//
// That split does not exist in this codebase. There is exactly ONE
// database (src/config/database.js) and ONE models/index.js containing
// every model. This file exists ONLY so that `require("../models/master")`
// resolves instead of crashing the process — it re-exports the
// MASTER-DESIGNATED subset of models from that same single connection.
//
// This does NOT give you real tenant data isolation at the database level
// (Tenant A and Tenant B still share one physical database, distinguished
// only by tenantId foreign keys, same as before Phase 5). Building the
// real separate-database-per-tenant architecture (master connection,
// tenant connection manager with LRU cache, defineTenantModels() factory,
// tenant resolver middleware, automated CREATE DATABASE provisioning) is
// substantial, separate work — see the final report.
const {
  Tenant,
  TenantDatabase,
  Plan,
  PlanFeature,
  Subscription,
  SubscriptionHistory,
  OtpVerification,
} = require("./index");

module.exports = {
  Tenant,
  TenantDatabase,
  Plan,
  PlanFeature,
  Subscription,
  SubscriptionHistory,
  OtpVerification,
};
