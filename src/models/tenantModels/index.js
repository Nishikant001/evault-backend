// src/models/tenantModels/index.js
//
// PHASE B — the Tenant Model Factory.
//
// defineTenantModels(sequelize) instantiates all 34 tenant-owned models
// against WHATEVER Sequelize connection is passed in (a specific tenant's
// physical database, once Phase C's connection manager exists) and wires
// up every association between them.
//
// WHAT'S NOT HERE: every association the legacy src/models/index.js has
// from a tenant model INTO a model that moved to the Master DB in Phase
// A/B (Tenant, TenantDatabase, Plan, PlanFeature, Subscription,
// SubscriptionHistory, OtpVerification, Department, TenantDepartment,
// ErpConfig) is intentionally NOT reproduced — those associations would
// span two different physical database connections, which Sequelize
// doesn't support. The FK *columns* (tenantId, departmentId,
// erpConfigId, approverDepartmentId, etc.) all still exist on the tenant
// models exactly as before; they're just plain integers now instead of
// also being a live `belongsTo`/`hasMany` association. Anywhere the app
// currently does `SomeTenantModel.findAll({ include: [Tenant] })` (or
// Department, or ErpConfig) will need a two-step lookup instead — Master
// DB call for the master-side row, then a separate tenant-DB query.
// That rewire happens where those call sites actually live (Phase E
// onward), not here — this file only defines what CAN be associated.
function defineTenantModels(sequelize) {
  const User = require("./User")(sequelize);
  const RefreshToken = require("./RefreshToken")(sequelize);
  const AuditLog = require("./AuditLog")(sequelize);
  const CompanyCode = require("./CompanyCode")(sequelize);
  const Plant = require("./Plant")(sequelize);
  const Category = require("./Category")(sequelize);
  const DocumentType = require("./DocumentType")(sequelize);
  const Document = require("./Document")(sequelize);
  const DocumentContent = require("./DocumentContent")(sequelize);
  const ApprovalWorkflow = require("./ApprovalWorkflow")(sequelize);
  const ApprovalLevel = require("./ApprovalLevel")(sequelize);
  const ApprovalAssignment = require("./ApprovalAssignment")(sequelize);
  const DocumentApproval = require("./DocumentApproval")(sequelize);
  const ApprovalHistory = require("./ApprovalHistory")(sequelize);
  const ApprovalComment = require("./ApprovalComment")(sequelize);
  const UserAssignment = require("./UserAssignment")(sequelize);
  const SapSyncLog = require("./SapSyncLog")(sequelize);
  const SapSyncRetryQueue = require("./SapSyncRetryQueue")(sequelize);
  const SapSyncSchedule = require("./SapSyncSchedule")(sequelize);
  const SapSyncSettings = require("./SapSyncSettings")(sequelize);
  const MetadataTemplate = require("./MetadataTemplate")(sequelize);
  const MetadataTemplateVersion = require("./MetadataTemplateVersion")(sequelize);
  const MetadataField = require("./MetadataField")(sequelize);
  const OcrAlias = require("./OcrAlias")(sequelize);
  const DocumentMetadata = require("./DocumentMetadata")(sequelize);
  const TemplateAssignment = require("./TemplateAssignment")(sequelize);
  const AIProvider = require("./AIProvider")(sequelize);
  const AISettings = require("./AISettings")(sequelize);
  const DocumentChunk = require("./DocumentChunk")(sequelize);
  const Embedding = require("./Embedding")(sequelize);
  const ChatSession = require("./ChatSession")(sequelize);
  const ChatMessage = require("./ChatMessage")(sequelize);
  const PromptHistory = require("./PromptHistory")(sequelize);
  const Notification = require("./Notification")(sequelize);
  const TenantDepartmentPlant = require("./TenantDepartmentPlant")(sequelize);
  const DocumentAccessRequest =
  require("./DocumentAccessRequest")(sequelize);

const CrossDepartmentDocumentShare =
  require("./CrossDepartmentDocumentShare")(sequelize);

  // MERGE — Internal Communication Module (1-to-1 chat + voice messages)
  const CommunicationConversation = require("./CommunicationConversation")(sequelize);
  const CommunicationParticipant = require("./CommunicationParticipant")(sequelize);
  const CommunicationMessage = require("./CommunicationMessage")(sequelize);
  const CommunicationVoiceMessage = require("./CommunicationVoiceMessage")(sequelize);
  const CommunicationAttachment = require("./CommunicationAttachment")(sequelize);
  const CommunicationCallSession = require("./CommunicationCallSession")(sequelize);

  

  // ── Auth / core ──────────────────────────────────────────────
  User.hasMany(RefreshToken, { foreignKey: "userId" });
  RefreshToken.belongsTo(User, { foreignKey: "userId" });

  User.hasMany(AuditLog, { foreignKey: "userId" });
  AuditLog.belongsTo(User, { foreignKey: "userId" });

  // ── Enterprise hierarchy: CompanyCode -> Plant (Tenant/Department level skipped — master) ──
  CompanyCode.hasMany(Plant, { foreignKey: "companyCodeId", as: "plants" });
  Plant.belongsTo(CompanyCode, { foreignKey: "companyCodeId" });

  // ── Tenant-specific Plant mapping for a (global, master-side) Department ──
  Plant.hasMany(TenantDepartmentPlant, { foreignKey: "plantId", as: "departmentMappings" });
  TenantDepartmentPlant.belongsTo(Plant, { foreignKey: "plantId" });

  CompanyCode.hasMany(TenantDepartmentPlant, { foreignKey: "companyCodeId" });
  TenantDepartmentPlant.belongsTo(CompanyCode, { foreignKey: "companyCodeId" });
  // NOTE: TenantDepartmentPlant.tenantDepartmentId and .departmentId are
  // plain integer columns referencing MASTER DB rows (tenant_departments,
  // departments) — no live association, no DB-level FK possible across
  // physical databases. See the long comment already in that model file.

  // ── Category / DocumentType (Department-level skipped — master) ──
  Category.hasMany(DocumentType, { foreignKey: "categoryId" });
  DocumentType.belongsTo(Category, { foreignKey: "categoryId" });

  // ── Documents ────────────────────────────────────────────────
  Category.hasMany(Document, { foreignKey: "categoryId" });
  Document.belongsTo(Category, { foreignKey: "categoryId" });

  DocumentType.hasMany(Document, { foreignKey: "documentTypeId" });
  Document.belongsTo(DocumentType, { foreignKey: "documentTypeId" });

  // ── Document Binary Content ───────────────────────────────
// Actual document binary is stored separately from document metadata.
// One Document can have at most one DocumentContent row.

Document.hasOne(DocumentContent, {
  foreignKey: "documentId",
  as: "content",
  onDelete: "CASCADE",
  onUpdate: "CASCADE",
});

DocumentContent.belongsTo(Document, {
  foreignKey: "documentId",
  as: "document",
  onDelete: "CASCADE",
  onUpdate: "CASCADE",
});

  User.hasMany(Document, { foreignKey: "uploadedBy" });
  Document.belongsTo(User, { foreignKey: "uploadedBy", as: "uploader" });

  Document.hasMany(Document, { as: "versions", foreignKey: "parentDocumentId" });
  Document.belongsTo(Document, { as: "parent", foreignKey: "parentDocumentId" });

  User.hasMany(Document, { foreignKey: "checkedOutBy", as: "checkedOutDocuments" });
  Document.belongsTo(User, { foreignKey: "checkedOutBy", as: "checkedOutByUser" });

  User.hasMany(Document, { foreignKey: "checkedInBy", as: "checkedInDocuments" });
  Document.belongsTo(User, { foreignKey: "checkedInBy", as: "checkedInByUser" });

  User.hasMany(Document, { foreignKey: "forceUnlockedBy", as: "forceUnlockedDocuments" });
  Document.belongsTo(User, { foreignKey: "forceUnlockedBy", as: "forceUnlockedByUser" });

  // ── Dynamic Approval Workflow Engine (Tenant/Department-level skipped — master) ──
  Category.hasMany(ApprovalWorkflow, { foreignKey: "categoryId" });
  ApprovalWorkflow.belongsTo(Category, { foreignKey: "categoryId" });

  DocumentType.hasMany(ApprovalWorkflow, { foreignKey: "documentTypeId" });
  ApprovalWorkflow.belongsTo(DocumentType, { foreignKey: "documentTypeId" });

  ApprovalWorkflow.hasMany(ApprovalLevel, { foreignKey: "approvalWorkflowId", as: "levels" });
  ApprovalLevel.belongsTo(ApprovalWorkflow, { foreignKey: "approvalWorkflowId" });

  ApprovalLevel.hasMany(ApprovalAssignment, { foreignKey: "approvalLevelId", as: "assignments" });
  ApprovalAssignment.belongsTo(ApprovalLevel, { foreignKey: "approvalLevelId" });

  User.hasMany(ApprovalAssignment, { foreignKey: "approverUserId" });
  ApprovalAssignment.belongsTo(User, { foreignKey: "approverUserId", as: "approverUser" });
  // NOTE: ApprovalAssignment.approverDepartmentId is a plain integer
  // referencing the MASTER DB departments table — no live association.

  Document.hasOne(DocumentApproval, { foreignKey: "documentId", as: "approval" });
  DocumentApproval.belongsTo(Document, { foreignKey: "documentId" });

  ApprovalWorkflow.hasMany(DocumentApproval, { foreignKey: "approvalWorkflowId" });
  DocumentApproval.belongsTo(ApprovalWorkflow, { foreignKey: "approvalWorkflowId" });

  User.hasMany(DocumentApproval, { foreignKey: "submittedBy" });
  DocumentApproval.belongsTo(User, { foreignKey: "submittedBy", as: "submitter" });

  User.hasMany(DocumentApproval, { foreignKey: "rejectedBy" });
  DocumentApproval.belongsTo(User, { foreignKey: "rejectedBy", as: "rejector" });

  DocumentApproval.hasMany(ApprovalHistory, { foreignKey: "documentApprovalId", as: "history" });
  ApprovalHistory.belongsTo(DocumentApproval, { foreignKey: "documentApprovalId" });

  Document.hasMany(ApprovalHistory, { foreignKey: "documentId" });
  ApprovalHistory.belongsTo(Document, { foreignKey: "documentId" });

  User.hasMany(ApprovalHistory, { foreignKey: "actionBy" });
  ApprovalHistory.belongsTo(User, { foreignKey: "actionBy", as: "actor" });

  DocumentApproval.hasMany(ApprovalComment, { foreignKey: "documentApprovalId", as: "comments" });
  ApprovalComment.belongsTo(DocumentApproval, { foreignKey: "documentApprovalId" });

  User.hasMany(ApprovalComment, { foreignKey: "userId" });
  ApprovalComment.belongsTo(User, { foreignKey: "userId", as: "commenter" });

  // ── Dynamic User Assignment Engine (Tenant/Department-level skipped — master) ──
  User.hasMany(UserAssignment, { foreignKey: "userId", as: "assignments" });
  UserAssignment.belongsTo(User, { foreignKey: "userId", as: "assignedUser" });

  User.hasMany(UserAssignment, { foreignKey: "assignedBy", as: "assignmentsGranted" });
  UserAssignment.belongsTo(User, { foreignKey: "assignedBy", as: "assignor" });
  // NOTE: UserAssignment.departmentId is a plain integer referencing the
  // MASTER DB departments table — no live association.

  Category.hasMany(UserAssignment, { foreignKey: "categoryId" });
  UserAssignment.belongsTo(Category, { foreignKey: "categoryId" });

  DocumentType.hasMany(UserAssignment, { foreignKey: "documentTypeId" });
  UserAssignment.belongsTo(DocumentType, { foreignKey: "documentTypeId" });

  // ── SAP Master / Document Synchronization (Tenant-level skipped — master) ──
  // NOTE: SapSyncLog.erpConfigId is a plain integer referencing the
  // MASTER DB erp_configs table — no live association.
  User.hasMany(SapSyncLog, { foreignKey: "triggeredBy" });
  SapSyncLog.belongsTo(User, { foreignKey: "triggeredBy", as: "triggeredByUser" });

  SapSyncLog.hasMany(SapSyncRetryQueue, { foreignKey: "sapSyncLogId", as: "retryItems" });
  SapSyncRetryQueue.belongsTo(SapSyncLog, { foreignKey: "sapSyncLogId" });
  // SapSyncSchedule / SapSyncSettings have no tenant-tenant associations
  // of their own beyond the (skipped, master-side) Tenant link.

  // ── Dynamic Metadata Template Engine / Form Builder (Tenant-level skipped — master) ──
  DocumentType.hasOne(MetadataTemplate, { foreignKey: "documentTypeId" });
  MetadataTemplate.belongsTo(DocumentType, { foreignKey: "documentTypeId" });

  User.hasMany(MetadataTemplate, { foreignKey: "createdBy" });
  MetadataTemplate.belongsTo(User, { foreignKey: "createdBy", as: "creator" });

  MetadataTemplate.hasMany(MetadataTemplateVersion, { foreignKey: "metadataTemplateId", as: "versions" });
  MetadataTemplateVersion.belongsTo(MetadataTemplate, { foreignKey: "metadataTemplateId" });

  User.hasMany(MetadataTemplateVersion, { foreignKey: "publishedBy" });
  MetadataTemplateVersion.belongsTo(User, { foreignKey: "publishedBy", as: "publisher" });

  User.hasMany(MetadataTemplateVersion, { foreignKey: "createdBy" });
  MetadataTemplateVersion.belongsTo(User, { foreignKey: "createdBy", as: "creator" });

  MetadataTemplateVersion.hasMany(MetadataField, { foreignKey: "metadataTemplateVersionId", as: "fields" });
  MetadataField.belongsTo(MetadataTemplateVersion, { foreignKey: "metadataTemplateVersionId" });

  MetadataField.hasMany(OcrAlias, { foreignKey: "metadataFieldId", as: "ocrAliases" });
  OcrAlias.belongsTo(MetadataField, { foreignKey: "metadataFieldId" });

  Document.hasOne(DocumentMetadata, { foreignKey: "documentId", as: "dynamicMetadata" });
  DocumentMetadata.belongsTo(Document, { foreignKey: "documentId" });

  MetadataTemplateVersion.hasMany(DocumentMetadata, { foreignKey: "metadataTemplateVersionId" });
  DocumentMetadata.belongsTo(MetadataTemplateVersion, { foreignKey: "metadataTemplateVersionId" });

  DocumentType.hasOne(TemplateAssignment, { foreignKey: "documentTypeId" });
  TemplateAssignment.belongsTo(DocumentType, { foreignKey: "documentTypeId" });

  MetadataTemplate.hasMany(TemplateAssignment, { foreignKey: "metadataTemplateId" });
  TemplateAssignment.belongsTo(MetadataTemplate, { foreignKey: "metadataTemplateId" });

  MetadataTemplateVersion.hasMany(TemplateAssignment, { foreignKey: "metadataTemplateVersionId" });
  TemplateAssignment.belongsTo(MetadataTemplateVersion, { foreignKey: "metadataTemplateVersionId" });

  User.hasMany(TemplateAssignment, { foreignKey: "assignedBy" });
  TemplateAssignment.belongsTo(User, { foreignKey: "assignedBy", as: "assignor" });

  // ── AI Document Assistant / RAG (Tenant-level skipped — master) ──
  User.hasMany(AIProvider, { foreignKey: "createdBy" });
  AIProvider.belongsTo(User, { foreignKey: "createdBy", as: "creator" });

  AIProvider.hasMany(AISettings, { foreignKey: "defaultChatProviderId", as: "chatSettings" });
  AISettings.belongsTo(AIProvider, { foreignKey: "defaultChatProviderId", as: "chatProvider" });
  AIProvider.hasMany(AISettings, { foreignKey: "defaultEmbeddingProviderId", as: "embeddingSettings" });
  AISettings.belongsTo(AIProvider, { foreignKey: "defaultEmbeddingProviderId", as: "embeddingProvider" });

  Document.hasMany(DocumentChunk, { foreignKey: "documentId", as: "chunks" });
  DocumentChunk.belongsTo(Document, { foreignKey: "documentId" });

  Document.hasOne(Embedding, { foreignKey: "documentId", as: "indexStatus" });
  Embedding.belongsTo(Document, { foreignKey: "documentId" });

  User.hasMany(ChatSession, { foreignKey: "userId" });
  ChatSession.belongsTo(User, { foreignKey: "userId" });

  ChatSession.hasMany(ChatMessage, { foreignKey: "sessionId", as: "messages" });
  ChatMessage.belongsTo(ChatSession, { foreignKey: "sessionId" });
  User.hasMany(ChatMessage, { foreignKey: "userId" });
  ChatMessage.belongsTo(User, { foreignKey: "userId" });

  User.hasMany(PromptHistory, { foreignKey: "userId" });
  PromptHistory.belongsTo(User, { foreignKey: "userId" });
  ChatSession.hasMany(PromptHistory, { foreignKey: "sessionId" });
  PromptHistory.belongsTo(ChatSession, { foreignKey: "sessionId" });

  // ── Notification (Tenant-level skipped — master) ──
  User.hasMany(Notification, { foreignKey: "userId" });
  Notification.belongsTo(User, { foreignKey: "userId" });

  // ── MERGE — Internal Communication Module (1-to-1 chat + voice
  // messages). Every association below is intra-tenant (both sides
  // live in this same tenant database) — kept exactly as the
  // communication backend defined them. The Tenant-level associations
  // it also defined (Tenant.hasMany(CommunicationX)) are intentionally
  // NOT reproduced here, same rationale as every other model in this
  // file: Tenant lives in the Master DB, a live association across two
  // physical database connections isn't possible. tenantId remains a
  // plain integer column on every communication model. ──────────────
  User.hasMany(CommunicationConversation, { foreignKey: "createdBy", as: "startedConversations" });
  CommunicationConversation.belongsTo(User, { foreignKey: "createdBy", as: "starter" });

  CommunicationConversation.belongsTo(User, { foreignKey: "participantAId", as: "participantA" });
  CommunicationConversation.belongsTo(User, { foreignKey: "participantBId", as: "participantB" });

  CommunicationConversation.hasMany(CommunicationParticipant, { foreignKey: "conversationId", as: "participants" });
  CommunicationParticipant.belongsTo(CommunicationConversation, { foreignKey: "conversationId" });

  User.hasMany(CommunicationParticipant, { foreignKey: "userId", as: "communicationMemberships" });
  CommunicationParticipant.belongsTo(User, { foreignKey: "userId" });

  CommunicationConversation.hasMany(CommunicationMessage, { foreignKey: "conversationId", as: "messages" });
  CommunicationMessage.belongsTo(CommunicationConversation, { foreignKey: "conversationId" });

  User.hasMany(CommunicationMessage, { foreignKey: "senderId", as: "sentCommunicationMessages" });
  CommunicationMessage.belongsTo(User, { foreignKey: "senderId", as: "sender" });

  CommunicationMessage.hasOne(CommunicationMessage, { foreignKey: "replyToMessageId", as: "repliesTo" });
  CommunicationMessage.belongsTo(CommunicationMessage, { foreignKey: "replyToMessageId", as: "replyToMessage" });

  CommunicationMessage.hasOne(CommunicationVoiceMessage, { foreignKey: "messageId", as: "voice" });
  CommunicationVoiceMessage.belongsTo(CommunicationMessage, { foreignKey: "messageId" });

  CommunicationMessage.hasMany(CommunicationAttachment, { foreignKey: "messageId", as: "attachments" });
  CommunicationAttachment.belongsTo(CommunicationMessage, { foreignKey: "messageId" });

  CommunicationConversation.hasMany(CommunicationCallSession, { foreignKey: "conversationId", as: "callSessions" });
  CommunicationCallSession.belongsTo(CommunicationConversation, { foreignKey: "conversationId" });

  User.hasMany(CommunicationCallSession, { foreignKey: "callerId", as: "outgoingCalls" });
  CommunicationCallSession.belongsTo(User, { foreignKey: "callerId", as: "caller" });

  User.hasMany(CommunicationCallSession, { foreignKey: "calleeId", as: "incomingCalls" });
  CommunicationCallSession.belongsTo(User, { foreignKey: "calleeId", as: "callee" });

  return {
    User,
    RefreshToken,
    AuditLog,
    CompanyCode,
    Plant,
    Category,
    DocumentType,
    Document,
    DocumentContent,
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
    Notification,
    TenantDepartmentPlant,
    DocumentAccessRequest,
CrossDepartmentDocumentShare,
    CommunicationConversation,
    CommunicationParticipant,
    CommunicationMessage,
    CommunicationVoiceMessage,
    CommunicationAttachment,
    CommunicationCallSession,
  };
}

module.exports = { defineTenantModels };
