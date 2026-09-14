// src/models/masterDb/index.js
//
// PHASE A — the real Master DB model registry.
//
// NAMED "masterDb", NOT "master": src/models/master.js (the Phase 5
// compatibility shim) already exists as a FILE at that path. Node's
// module resolution always prefers a same-named .js file over a
// same-named directory, so a `src/models/master/` directory here would
// have been silently and completely unreachable via
// `require("../models/master")` — every caller would keep getting the
// old shim with no error. Rather than leave that landmine in place,
// this real implementation lives at a non-colliding path. Phase E is
// where src/models/master.js (the shim) gets deleted and every current
// `require("../models/master")` call site gets repointed at this
// directory — until then, nothing in the running app touches this file.
//
// Associations defined here are ONLY between models that both live in
// the Master DB. Every association the legacy src/models/index.js has
// from Tenant into tenant-operational models (User, Document, Category,
// ApprovalWorkflow, AIProvider, Notification, SapSyncLog, ...) is
// intentionally NOT reproduced — those models belong on a different,
// per-tenant Sequelize connection (Phase B/C), and Sequelize associations
// only work within a single connection. See the long comment in
// master/Tenant.js for the full explanation and what replaces those
// eager-loads (a two-step lookup, wired up in Phase E).
const masterSequelize = require("../../config/masterDatabase");

const Tenant = require("./Tenant");
const TenantDatabase = require("./TenantDatabase");
const Plan = require("./Plan");
const PlanFeature = require("./PlanFeature");
const Subscription = require("./Subscription");
const SubscriptionHistory = require("./SubscriptionHistory");
const OtpVerification = require("./OtpVerification");
const Department = require("./Department");
const TenantDepartment = require("./TenantDepartment");
const ErpConfig = require("./ErpConfig");
const TenantErpConnection = require("./TenantErpConnection");
const GlobalUserIndex = require("./GlobalUserIndex");
const SuperAdmin = require("./SuperAdmin");
const SystemModule = require("./SystemModule");
const TenantModule = require("./TenantModule");

// ── Tenant ↔ GlobalUserIndex (1:many — PHASE D) ──
Tenant.hasMany(GlobalUserIndex, { foreignKey: "tenantId" });
GlobalUserIndex.belongsTo(Tenant, { foreignKey: "tenantId" });

// ── Tenant ↔ TenantDatabase (1:1 — a tenant has exactly one physical DB record) ──
Tenant.hasOne(TenantDatabase, { foreignKey: "tenantId" });
TenantDatabase.belongsTo(Tenant, { foreignKey: "tenantId" });

// ── Tenant ↔ Subscription (1:1 — one active subscription row per tenant) ──
Tenant.hasOne(Subscription, { foreignKey: "tenantId" });
Subscription.belongsTo(Tenant, { foreignKey: "tenantId" });

// ── Plan ↔ Subscription ──
Plan.hasMany(Subscription, { foreignKey: "planId" });
Subscription.belongsTo(Plan, { foreignKey: "planId" });

// ── Plan ↔ PlanFeature ──
Plan.hasMany(PlanFeature, { foreignKey: "planId", as: "features" });
PlanFeature.belongsTo(Plan, { foreignKey: "planId" });

// ── Tenant ↔ SubscriptionHistory ──
Tenant.hasMany(SubscriptionHistory, { foreignKey: "tenantId" });
SubscriptionHistory.belongsTo(Tenant, { foreignKey: "tenantId" });

// ── Plan ↔ SubscriptionHistory (fromPlan / toPlan) ──
Plan.hasMany(SubscriptionHistory, { foreignKey: "fromPlanId", as: "historyFrom" });
SubscriptionHistory.belongsTo(Plan, { foreignKey: "fromPlanId", as: "fromPlan" });

Plan.hasMany(SubscriptionHistory, { foreignKey: "toPlanId", as: "historyTo" });
SubscriptionHistory.belongsTo(Plan, { foreignKey: "toPlanId", as: "toPlan" });

// NOTE: SubscriptionHistory.performedBy intentionally has NO association
// here (legacy shared-DB version aliases it to User as "performer") —
// User lives in the tenant DB, not the Master DB. See the comment in
// master/SubscriptionHistory.js.

// NOTE: OtpVerification has no associations, in either the legacy or this
// version — it's a standalone, short-lived verification record keyed
// only by mobileNumber, never joined to anything.

// ── ErpConfig ↔ Tenant (PHASE B addition) ──
// ErpConfig has no tenantId — one ErpConfig (SAP landscape) can be
// assigned to many tenants via Tenant.erpConfigId.
ErpConfig.hasMany(Tenant, { foreignKey: "erpConfigId" });
Tenant.belongsTo(ErpConfig, { foreignKey: "erpConfigId" });

// Tenant ↔ ERP connections (many-to-many through an explicit Master DB mapping).
// Keeps legacy Tenant.erpConfigId for backward compatibility while allowing one
// tenant to have multiple inbound/outbound ERP connections simultaneously.
Tenant.hasMany(TenantErpConnection, { foreignKey: "tenantId", as: "erpConnections" });
TenantErpConnection.belongsTo(Tenant, { foreignKey: "tenantId" });
ErpConfig.hasMany(TenantErpConnection, { foreignKey: "erpConfigId", as: "tenantConnections" });
TenantErpConnection.belongsTo(ErpConfig, { foreignKey: "erpConfigId", as: "erpConfig" });

// ── Department ↔ Tenant, via TenantDepartment (PHASE B addition) ──
// SuperAdmin manages Department master (no tenant FK on Department);
// TenantDepartment is the admin-controlled grant of which Departments a
// given tenant may use. Both now live in the Master DB alongside Tenant,
// so this many-to-many stays a real, enforced association.
Tenant.belongsToMany(Department, {
  through: TenantDepartment,
  foreignKey: "tenantId",
  otherKey: "departmentId",
  as: "departments",
});
Department.belongsToMany(Tenant, {
  through: TenantDepartment,
  foreignKey: "departmentId",
  otherKey: "tenantId",
  as: "tenants",
});
TenantDepartment.belongsTo(Tenant, { foreignKey: "tenantId" });
TenantDepartment.belongsTo(Department, { foreignKey: "departmentId" });

// NOTE ON WHAT'S DELIBERATELY NOT HERE: the legacy Department also has
// Plant.hasMany(Department, {foreignKey:"plantId", as:"legacyDepartments"})
// (the deprecated single-Plant-link column) and Department.hasMany(Category)
// / Department.hasMany(ApprovalWorkflow) / etc. Plant, Category, and
// ApprovalWorkflow are all TENANT DB models (Phase B tenantModels/) — those
// associations cross the Master/Tenant boundary and are NOT reproduced
// here, for the same reason documented in Tenant.js. The plantId column
// on Department itself is kept (deprecated, read-only) but is no longer a
// live Sequelize association in either direction. Code that queried
// `Department.getCategories()` or similar will need the two-step lookup
// pattern in Phase E/H, same as every other master/tenant boundary case.

// ── Tenant ↔ SystemModule (many-to-many through TenantModule) ──
Tenant.belongsToMany(SystemModule, { through: TenantModule, foreignKey: "tenantId", otherKey: "moduleId", as: "modules" });
SystemModule.belongsToMany(Tenant, { through: TenantModule, foreignKey: "moduleId", otherKey: "tenantId", as: "tenants" });
TenantModule.belongsTo(Tenant, { foreignKey: "tenantId" });
TenantModule.belongsTo(SystemModule, { foreignKey: "moduleId" });
SystemModule.hasMany(TenantModule, { foreignKey: "moduleId", as: "tenantAssignments" });
Tenant.hasMany(TenantModule, { foreignKey: "tenantId", as: "moduleAssignments" });

module.exports = {
  masterSequelize,
  Tenant,
  TenantDatabase,
  Plan,
  PlanFeature,
  Subscription,
  SubscriptionHistory,
  OtpVerification,
  Department,
  TenantDepartment,
  ErpConfig,
  TenantErpConnection,
  GlobalUserIndex,
  SuperAdmin,
  SystemModule,
  TenantModule,
};
