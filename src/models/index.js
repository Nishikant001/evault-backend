// src/models/index.js
//
// PHASE G — LEGACY SHARED-DATABASE MODEL SET. RETAINED FOR MIGRATION
// TOOLING ONLY. NOT USED BY THE PRODUCTION APPLICATION.
//
// See src/config/database.js's header comment for the full explanation —
// this file defines the models for that same legacy connection, and is
// kept for exactly the same reason (src/database/legacyMigration/* still
// reads from it as the migration source). Production code should never
// import this file directly; use req.models (tenant-side, set by
// tenantResolverMiddleware), req.masterModels (src/models/masterDb), or
// getTenantConnection(tenantId) (src/services/tenantConnectionManager.js)
// instead. See PHASE_G_LEGACY_REMOVAL_REPORT.md for the full record of
// every file that was converted off this import.
const Tenant         = require("./Tenant");
const User           = require("./User");
const RefreshToken   = require("./RefreshToken");
const AuditLog       = require("./AuditLog");
const CompanyCode    = require("./CompanyCode");
const Plant          = require("./Plant");
const Department     = require("./Department");
const TenantDepartment = require("./TenantDepartment");
const TenantDepartmentPlant = require("./TenantDepartmentPlant");
const Category       = require("./Category");
const DocumentType   = require("./DocumentType");
const Document       = require("./Document");
const ErpConfig = require("./ErpConfig");
const ApprovalWorkflow   = require("./ApprovalWorkflow");
const ApprovalLevel      = require("./ApprovalLevel");
const ApprovalAssignment = require("./ApprovalAssignment");
const DocumentApproval   = require("./DocumentApproval");
const ApprovalHistory    = require("./ApprovalHistory");
const ApprovalComment    = require("./ApprovalComment");
const UserAssignment     = require("./UserAssignment");
const SapSyncLog         = require("./SapSyncLog");
const SapSyncRetryQueue  = require("./SapSyncRetryQueue");
const SapSyncSchedule    = require("./SapSyncSchedule");
const SapSyncSettings    = require("./SapSyncSettings");
const MetadataTemplate         = require("./MetadataTemplate");
const MetadataTemplateVersion  = require("./MetadataTemplateVersion");
const MetadataField            = require("./MetadataField");
const OcrAlias                 = require("./OcrAlias");
const DocumentMetadata          = require("./DocumentMetadata");
const TemplateAssignment        = require("./TemplateAssignment");

// ── AI Document Assistant (RAG) ──────────────────────────────
const AIProvider     = require("./AIProvider");
const AISettings     = require("./AISettings");
const DocumentChunk  = require("./DocumentChunk");
const Embedding      = require("./Embedding");
const ChatSession    = require("./ChatSession");
const ChatMessage    = require("./ChatMessage");
const PromptHistory  = require("./PromptHistory");

// ── Subscription Management System ───────────────────────────
const Plan                 = require("./Plan");
const TenantDatabase       = require("./TenantDatabase");
const PlanFeature           = require("./PlanFeature");
const Subscription          = require("./Subscription");
const SubscriptionHistory   = require("./SubscriptionHistory");
const OtpVerification       = require("./OtpVerification");
const Notification          = require("./Notification");

// ── Existing associations ──────────────────────────────────
Tenant.hasMany(User,         { foreignKey: "tenantId" });
User.belongsTo(Tenant,       { foreignKey: "tenantId" });

User.hasMany(RefreshToken,   { foreignKey: "userId" });
RefreshToken.belongsTo(User, { foreignKey: "userId" });

User.hasMany(AuditLog,       { foreignKey: "userId" });
AuditLog.belongsTo(User,     { foreignKey: "userId" });

// ── Enterprise hierarchy: Tenant -> CompanyCode -> Plant -> Department ──
// (SAP SD style organizational structure)
Tenant.hasMany(CompanyCode,        { foreignKey: "tenantId", as: "companyCodes" });
CompanyCode.belongsTo(Tenant,      { foreignKey: "tenantId" });

CompanyCode.hasMany(Plant,         { foreignKey: "companyCodeId", as: "plants" });
Plant.belongsTo(CompanyCode,       { foreignKey: "companyCodeId" });

Tenant.hasMany(Plant,              { foreignKey: "tenantId" });
Plant.belongsTo(Tenant,            { foreignKey: "tenantId" });

// DEPRECATED — `Department.plantId` is a legacy single global column that
// caused tenant-configuration leakage (see TenantDepartmentPlant.js for the
// full explanation). Kept ONLY for backward-compatible reads of old data;
// the application no longer writes to it. Use the TenantDepartmentPlant
// mapping table below for all new plant<->department assignment logic.
Plant.hasMany(Department,          { foreignKey: "plantId", as: "legacyDepartments" });
Department.belongsTo(Plant,        { foreignKey: "plantId", as: "legacyPlant" });

// ── Department master ──────────────────────────────────────
// SuperAdmin manages Department master (no tenant FK on Department)

// Admin assigns departments to tenants
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
TenantDepartment.belongsTo(Tenant,     { foreignKey: "tenantId" });
TenantDepartment.belongsTo(Department, { foreignKey: "departmentId" });

// ── Tenant-specific Plant mapping for a (global) Department ────
// This is the fix for tenant configuration leaking through the shared
// Department master. Each row scopes a Plant assignment to exactly one
// tenant's TenantDepartment grant; it never touches Department or
// TenantDepartment rows themselves.
TenantDepartment.hasMany(TenantDepartmentPlant, { foreignKey: "tenantDepartmentId", as: "plantMappings" });
TenantDepartmentPlant.belongsTo(TenantDepartment, { foreignKey: "tenantDepartmentId" });

Tenant.hasMany(TenantDepartmentPlant,       { foreignKey: "tenantId" });
TenantDepartmentPlant.belongsTo(Tenant,     { foreignKey: "tenantId" });

Department.hasMany(TenantDepartmentPlant,   { foreignKey: "departmentId" });
TenantDepartmentPlant.belongsTo(Department, { foreignKey: "departmentId" });

Plant.hasMany(TenantDepartmentPlant,        { foreignKey: "plantId", as: "departmentMappings" });
TenantDepartmentPlant.belongsTo(Plant,      { foreignKey: "plantId" });

CompanyCode.hasMany(TenantDepartmentPlant,       { foreignKey: "companyCodeId" });
TenantDepartmentPlant.belongsTo(CompanyCode,     { foreignKey: "companyCodeId" });

// ── Tenant's categories (under an assigned department) ─────
Tenant.hasMany(Category,     { foreignKey: "tenantId" });
Category.belongsTo(Tenant,   { foreignKey: "tenantId" });

Department.hasMany(Category, { foreignKey: "departmentId" });
Category.belongsTo(Department, { foreignKey: "departmentId" });

// ── Tenant's document types (under a category) ─────────────
Category.hasMany(DocumentType,     { foreignKey: "categoryId" });
DocumentType.belongsTo(Category,   { foreignKey: "categoryId" });

Tenant.hasMany(DocumentType,       { foreignKey: "tenantId" });
DocumentType.belongsTo(Tenant,     { foreignKey: "tenantId" });

// ── Documents ───────────────────────────────────────────────
Tenant.hasMany(Document,           { foreignKey: "tenantId" });
Document.belongsTo(Tenant,         { foreignKey: "tenantId" });

Department.hasMany(Document,       { foreignKey: "departmentId" });
Document.belongsTo(Department,     { foreignKey: "departmentId" });

Category.hasMany(Document,         { foreignKey: "categoryId" });
Document.belongsTo(Category,       { foreignKey: "categoryId" });

DocumentType.hasMany(Document,     { foreignKey: "documentTypeId" });
Document.belongsTo(DocumentType,   { foreignKey: "documentTypeId" });

User.hasMany(Document,             { foreignKey: "uploadedBy" });
Document.belongsTo(User,           { foreignKey: "uploadedBy", as: "uploader" });

// ✅ YAHAN ADD KARO — Document version chain
Document.hasMany(Document, { as: "versions", foreignKey: "parentDocumentId" });
Document.belongsTo(Document, { as: "parent", foreignKey: "parentDocumentId" });

// ── Enterprise Check-In / Check-Out — lock actor associations ─
User.hasMany(Document,             { foreignKey: "checkedOutBy", as: "checkedOutDocuments" });
Document.belongsTo(User,           { foreignKey: "checkedOutBy", as: "checkedOutByUser" });

User.hasMany(Document,             { foreignKey: "checkedInBy", as: "checkedInDocuments" });
Document.belongsTo(User,           { foreignKey: "checkedInBy", as: "checkedInByUser" });

User.hasMany(Document,             { foreignKey: "forceUnlockedBy", as: "forceUnlockedDocuments" });
Document.belongsTo(User,           { foreignKey: "forceUnlockedBy", as: "forceUnlockedByUser" });

ErpConfig.hasMany(Tenant, {
  foreignKey: "erpConfigId",
});

Tenant.belongsTo(ErpConfig, {
  foreignKey: "erpConfigId",
});

// ── Dynamic Approval Workflow Engine ───────────────────────
// ApprovalWorkflow: scoped to one Tenant+Department+Category+DocumentType
Tenant.hasMany(ApprovalWorkflow,           { foreignKey: "tenantId" });
ApprovalWorkflow.belongsTo(Tenant,         { foreignKey: "tenantId" });

Department.hasMany(ApprovalWorkflow,       { foreignKey: "departmentId" });
ApprovalWorkflow.belongsTo(Department,     { foreignKey: "departmentId" });

Category.hasMany(ApprovalWorkflow,         { foreignKey: "categoryId" });
ApprovalWorkflow.belongsTo(Category,       { foreignKey: "categoryId" });

DocumentType.hasMany(ApprovalWorkflow,     { foreignKey: "documentTypeId" });
ApprovalWorkflow.belongsTo(DocumentType,   { foreignKey: "documentTypeId" });

// ApprovalLevel: ordered steps within a workflow
ApprovalWorkflow.hasMany(ApprovalLevel,    { foreignKey: "approvalWorkflowId", as: "levels" });
ApprovalLevel.belongsTo(ApprovalWorkflow,  { foreignKey: "approvalWorkflowId" });

// ApprovalAssignment: who can act at a given level
ApprovalLevel.hasMany(ApprovalAssignment,  { foreignKey: "approvalLevelId", as: "assignments" });
ApprovalAssignment.belongsTo(ApprovalLevel,{ foreignKey: "approvalLevelId" });

User.hasMany(ApprovalAssignment,           { foreignKey: "approverUserId" });
ApprovalAssignment.belongsTo(User,         { foreignKey: "approverUserId", as: "approverUser" });

Department.hasMany(ApprovalAssignment,     { foreignKey: "approverDepartmentId" });
ApprovalAssignment.belongsTo(Department,   { foreignKey: "approverDepartmentId", as: "approverDepartment" });

// DocumentApproval: runtime instance tracking one document's approval run
Document.hasOne(DocumentApproval,          { foreignKey: "documentId", as: "approval" });
DocumentApproval.belongsTo(Document,       { foreignKey: "documentId" });

ApprovalWorkflow.hasMany(DocumentApproval,  { foreignKey: "approvalWorkflowId" });
DocumentApproval.belongsTo(ApprovalWorkflow,{ foreignKey: "approvalWorkflowId" });

Tenant.hasMany(DocumentApproval,           { foreignKey: "tenantId" });
DocumentApproval.belongsTo(Tenant,         { foreignKey: "tenantId" });

User.hasMany(DocumentApproval,              { foreignKey: "submittedBy" });
DocumentApproval.belongsTo(User,           { foreignKey: "submittedBy", as: "submitter" });

User.hasMany(DocumentApproval,              { foreignKey: "rejectedBy" });
DocumentApproval.belongsTo(User,           { foreignKey: "rejectedBy", as: "rejector" });

// ApprovalHistory: immutable ledger of every action
DocumentApproval.hasMany(ApprovalHistory,   { foreignKey: "documentApprovalId", as: "history" });
ApprovalHistory.belongsTo(DocumentApproval, { foreignKey: "documentApprovalId" });

Document.hasMany(ApprovalHistory,          { foreignKey: "documentId" });
ApprovalHistory.belongsTo(Document,        { foreignKey: "documentId" });

User.hasMany(ApprovalHistory,               { foreignKey: "actionBy" });
ApprovalHistory.belongsTo(User,             { foreignKey: "actionBy", as: "actor" });

// ApprovalComment: freeform discussion thread
DocumentApproval.hasMany(ApprovalComment,   { foreignKey: "documentApprovalId", as: "comments" });
ApprovalComment.belongsTo(DocumentApproval, { foreignKey: "documentApprovalId" });

User.hasMany(ApprovalComment,                { foreignKey: "userId" });
ApprovalComment.belongsTo(User,             { foreignKey: "userId", as: "commenter" });

// ── Dynamic User Assignment Engine ─────────────────────────
// A UserAssignment grants ONE user access at exactly one hierarchy level
// (DEPARTMENT / CATEGORY / DOCUMENT_TYPE). Purely additive: does not
// touch any existing Category/DocumentType/Document association above.
Tenant.hasMany(UserAssignment,           { foreignKey: "tenantId" });
UserAssignment.belongsTo(Tenant,         { foreignKey: "tenantId" });

User.hasMany(UserAssignment,             { foreignKey: "userId", as: "assignments" });
UserAssignment.belongsTo(User,           { foreignKey: "userId", as: "assignedUser" });

User.hasMany(UserAssignment,             { foreignKey: "assignedBy", as: "assignmentsGranted" });
UserAssignment.belongsTo(User,           { foreignKey: "assignedBy", as: "assignor" });

Department.hasMany(UserAssignment,       { foreignKey: "departmentId" });
UserAssignment.belongsTo(Department,     { foreignKey: "departmentId" });

Category.hasMany(UserAssignment,         { foreignKey: "categoryId" });
UserAssignment.belongsTo(Category,       { foreignKey: "categoryId" });

DocumentType.hasMany(UserAssignment,     { foreignKey: "documentTypeId" });
UserAssignment.belongsTo(DocumentType,   { foreignKey: "documentTypeId" });

// ── SAP Master / Document Synchronization ──────────────────
// SapSyncLog: one row per sync run (MASTER or DOCUMENT), scoped to the
// tenant whose ErpConfig drove it. Purely additive.
Tenant.hasMany(SapSyncLog,               { foreignKey: "tenantId" });
SapSyncLog.belongsTo(Tenant,             { foreignKey: "tenantId" });

ErpConfig.hasMany(SapSyncLog,            { foreignKey: "erpConfigId" });
SapSyncLog.belongsTo(ErpConfig,          { foreignKey: "erpConfigId" });

User.hasMany(SapSyncLog,                 { foreignKey: "triggeredBy" });
SapSyncLog.belongsTo(User,               { foreignKey: "triggeredBy", as: "triggeredByUser" });

// SapSyncRetryQueue: one row per failed record awaiting automatic retry.
Tenant.hasMany(SapSyncRetryQueue,        { foreignKey: "tenantId" });
SapSyncRetryQueue.belongsTo(Tenant,      { foreignKey: "tenantId" });

SapSyncLog.hasMany(SapSyncRetryQueue,    { foreignKey: "sapSyncLogId", as: "retryItems" });
SapSyncRetryQueue.belongsTo(SapSyncLog,  { foreignKey: "sapSyncLogId" });

// SapSyncSchedule: one row per (tenant, job) — drives the Scheduler page.
Tenant.hasMany(SapSyncSchedule,          { foreignKey: "tenantId" });
SapSyncSchedule.belongsTo(Tenant,        { foreignKey: "tenantId" });

// SapSyncSettings: one row per tenant — drives the Settings page.
Tenant.hasOne(SapSyncSettings,           { foreignKey: "tenantId" });
SapSyncSettings.belongsTo(Tenant,        { foreignKey: "tenantId" });

// ── Dynamic Metadata Template Engine / Form Builder ────────
// MetadataTemplate: exactly one per (tenant, documentType)
Tenant.hasMany(MetadataTemplate,             { foreignKey: "tenantId" });
MetadataTemplate.belongsTo(Tenant,           { foreignKey: "tenantId" });

DocumentType.hasOne(MetadataTemplate,        { foreignKey: "documentTypeId" });
MetadataTemplate.belongsTo(DocumentType,     { foreignKey: "documentTypeId" });

User.hasMany(MetadataTemplate,               { foreignKey: "createdBy" });
MetadataTemplate.belongsTo(User,             { foreignKey: "createdBy", as: "creator" });

// MetadataTemplateVersion: versioned snapshots of a template
MetadataTemplate.hasMany(MetadataTemplateVersion,   { foreignKey: "metadataTemplateId", as: "versions" });
MetadataTemplateVersion.belongsTo(MetadataTemplate, { foreignKey: "metadataTemplateId" });

User.hasMany(MetadataTemplateVersion,        { foreignKey: "publishedBy" });
MetadataTemplateVersion.belongsTo(User,      { foreignKey: "publishedBy", as: "publisher" });

User.hasMany(MetadataTemplateVersion,        { foreignKey: "createdBy" });
MetadataTemplateVersion.belongsTo(User,      { foreignKey: "createdBy", as: "creator" });

// MetadataField: Form Builder fields within one version
MetadataTemplateVersion.hasMany(MetadataField, { foreignKey: "metadataTemplateVersionId", as: "fields" });
MetadataField.belongsTo(MetadataTemplateVersion, { foreignKey: "metadataTemplateVersionId" });

// OcrAlias: alternate labels an OCR-mapped field should also recognize
MetadataField.hasMany(OcrAlias,              { foreignKey: "metadataFieldId", as: "ocrAliases" });
OcrAlias.belongsTo(MetadataField,            { foreignKey: "metadataFieldId" });

// DocumentMetadata: dynamic OCR pipeline result for one Document
Document.hasOne(DocumentMetadata,            { foreignKey: "documentId", as: "dynamicMetadata" });
DocumentMetadata.belongsTo(Document,         { foreignKey: "documentId" });

MetadataTemplateVersion.hasMany(DocumentMetadata,   { foreignKey: "metadataTemplateVersionId" });
DocumentMetadata.belongsTo(MetadataTemplateVersion, { foreignKey: "metadataTemplateVersionId" });

// TemplateAssignment: which published version is "live" for a DocumentType
Tenant.hasMany(TemplateAssignment,           { foreignKey: "tenantId" });
TemplateAssignment.belongsTo(Tenant,         { foreignKey: "tenantId" });

DocumentType.hasOne(TemplateAssignment,      { foreignKey: "documentTypeId" });
TemplateAssignment.belongsTo(DocumentType,   { foreignKey: "documentTypeId" });

MetadataTemplate.hasMany(TemplateAssignment, { foreignKey: "metadataTemplateId" });
TemplateAssignment.belongsTo(MetadataTemplate, { foreignKey: "metadataTemplateId" });

MetadataTemplateVersion.hasMany(TemplateAssignment,   { foreignKey: "metadataTemplateVersionId" });
TemplateAssignment.belongsTo(MetadataTemplateVersion, { foreignKey: "metadataTemplateVersionId" });

User.hasMany(TemplateAssignment,             { foreignKey: "assignedBy" });
TemplateAssignment.belongsTo(User,           { foreignKey: "assignedBy", as: "assignor" });

// ── AI Document Assistant (RAG) ──────────────────────────────
// AIProvider: tenant-scoped (or platform-wide when tenantId is null)
Tenant.hasMany(AIProvider,                   { foreignKey: "tenantId" });
AIProvider.belongsTo(Tenant,                 { foreignKey: "tenantId" });
User.hasMany(AIProvider,                     { foreignKey: "createdBy" });
AIProvider.belongsTo(User,                   { foreignKey: "createdBy", as: "creator" });

// AISettings: one row per tenant
Tenant.hasOne(AISettings,                    { foreignKey: "tenantId" });
AISettings.belongsTo(Tenant,                 { foreignKey: "tenantId" });
AIProvider.hasMany(AISettings,               { foreignKey: "defaultChatProviderId", as: "chatSettings" });
AISettings.belongsTo(AIProvider,             { foreignKey: "defaultChatProviderId", as: "chatProvider" });
AIProvider.hasMany(AISettings,               { foreignKey: "defaultEmbeddingProviderId", as: "embeddingSettings" });
AISettings.belongsTo(AIProvider,             { foreignKey: "defaultEmbeddingProviderId", as: "embeddingProvider" });

// DocumentChunk: RAG chunks + vectors for a Document
Tenant.hasMany(DocumentChunk,                { foreignKey: "tenantId" });
DocumentChunk.belongsTo(Tenant,              { foreignKey: "tenantId" });
Document.hasMany(DocumentChunk,              { foreignKey: "documentId", as: "chunks" });
DocumentChunk.belongsTo(Document,            { foreignKey: "documentId" });

// Embedding: one row per Document — indexing job/status tracker
Tenant.hasMany(Embedding,                    { foreignKey: "tenantId" });
Embedding.belongsTo(Tenant,                  { foreignKey: "tenantId" });
Document.hasOne(Embedding,                   { foreignKey: "documentId", as: "indexStatus" });
Embedding.belongsTo(Document,                { foreignKey: "documentId" });

// ChatSession / ChatMessage
Tenant.hasMany(ChatSession,                  { foreignKey: "tenantId" });
ChatSession.belongsTo(Tenant,                { foreignKey: "tenantId" });
User.hasMany(ChatSession,                    { foreignKey: "userId" });
ChatSession.belongsTo(User,                  { foreignKey: "userId" });

ChatSession.hasMany(ChatMessage,             { foreignKey: "sessionId", as: "messages" });
ChatMessage.belongsTo(ChatSession,           { foreignKey: "sessionId" });
Tenant.hasMany(ChatMessage,                  { foreignKey: "tenantId" });
ChatMessage.belongsTo(Tenant,                { foreignKey: "tenantId" });
User.hasMany(ChatMessage,                    { foreignKey: "userId" });
ChatMessage.belongsTo(User,                  { foreignKey: "userId" });

// PromptHistory: flat AI usage/audit log across all AI features
Tenant.hasMany(PromptHistory,                { foreignKey: "tenantId" });
PromptHistory.belongsTo(Tenant,              { foreignKey: "tenantId" });
User.hasMany(PromptHistory,                  { foreignKey: "userId" });
PromptHistory.belongsTo(User,                { foreignKey: "userId" });
ChatSession.hasMany(PromptHistory,           { foreignKey: "sessionId" });
PromptHistory.belongsTo(ChatSession,         { foreignKey: "sessionId" });

// ── Subscription Management System ───────────────────────────
// One Subscription per Tenant — this is the row subscriptionMiddleware
// reads on every request.
Tenant.hasOne(Subscription,             { foreignKey: "tenantId" });
Subscription.belongsTo(Tenant,          { foreignKey: "tenantId" });

Plan.hasMany(Subscription,              { foreignKey: "planId" });
Subscription.belongsTo(Plan,            { foreignKey: "planId" });

// PlanFeature: feature flags per plan — every future plan tier (Professional,
// Enterprise, Premium) is just new rows here, no code changes.
Plan.hasMany(PlanFeature,               { foreignKey: "planId", as: "features" });
PlanFeature.belongsTo(Plan,             { foreignKey: "planId" });

// SubscriptionHistory: audit trail for plan changes
Tenant.hasMany(SubscriptionHistory,     { foreignKey: "tenantId" });
SubscriptionHistory.belongsTo(Tenant,   { foreignKey: "tenantId" });

Plan.hasMany(SubscriptionHistory,       { foreignKey: "fromPlanId", as: "historyFrom" });
SubscriptionHistory.belongsTo(Plan,     { foreignKey: "fromPlanId", as: "fromPlan" });

Plan.hasMany(SubscriptionHistory,       { foreignKey: "toPlanId", as: "historyTo" });
SubscriptionHistory.belongsTo(Plan,     { foreignKey: "toPlanId", as: "toPlan" });

User.hasMany(SubscriptionHistory,       { foreignKey: "performedBy" });
SubscriptionHistory.belongsTo(User,     { foreignKey: "performedBy", as: "performer" });

// Notification: in-app dashboard notifications (userId null = tenant-wide)
Tenant.hasMany(Notification,            { foreignKey: "tenantId" });
Notification.belongsTo(Tenant,          { foreignKey: "tenantId" });
User.hasMany(Notification,              { foreignKey: "userId" });
Notification.belongsTo(User,            { foreignKey: "userId" });

// OtpVerification has no FK — resolved by mobileNumber at verify time,
// since the User/Tenant don't exist yet during FREE registration.

// TenantDatabase: MASTER-side provisioning record referenced by the
// Phase 5-converted tenantController.js/planController.js. See the
// compatibility note in TenantDatabase.js — this is a shim table in the
// SAME shared database, not a real per-tenant physical database record.
Tenant.hasOne(TenantDatabase,           { foreignKey: "tenantId" });
TenantDatabase.belongsTo(Tenant,        { foreignKey: "tenantId" });

module.exports = {
  Tenant,
  User,
  RefreshToken,
  AuditLog,
  CompanyCode,
  Plant,
  Department,
  TenantDepartment,
  TenantDepartmentPlant,
  Category,
  DocumentType,
  Document,
  ErpConfig,
  ApprovalWorkflow,
  ApprovalLevel,
  ApprovalAssignment,
  DocumentApproval,
  ApprovalHistory,
  ApprovalComment,
  UserAssignment,
  SapSyncLog,
  SapSyncRetryQueue,
  SapSyncSchedule,
  SapSyncSettings,
  MetadataTemplate,
  MetadataTemplateVersion,
  MetadataField,
  OcrAlias,
  DocumentMetadata,
  TemplateAssignment,
  AIProvider,
  AISettings,
  DocumentChunk,
  Embedding,
  ChatSession,
  ChatMessage,
  PromptHistory,
  Plan,
  PlanFeature,
  Subscription,
  SubscriptionHistory,
  OtpVerification,
  Notification,
  TenantDatabase,
};