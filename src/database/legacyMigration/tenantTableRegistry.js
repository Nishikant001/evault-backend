// src/database/legacyMigration/tenantTableRegistry.js
//
// PHASE F — declarative registry of every legacy-shared-DB table that
// belongs to a tenant and must be migrated into that tenant's own
// physical database.
//
// This is NOT a redesign of the schema — it is a description of the
// dependency graph that ALREADY EXISTS in src/models/index.js (legacy)
// and src/models/tenantModels/index.js (tenant), derived by reading the
// real `references:` / association declarations in both, not assumed.
//
// Two kinds of tables:
//   - MASTER-SIDE reference data (Tenant, TenantDatabase, Plan,
//     PlanFeature, Subscription, SubscriptionHistory, OtpVerification,
//     Department, TenantDepartment, ErpConfig, GlobalUserIndex,
//     SuperAdmin) — these already live in the Master DB per Phase A/D's
//     own classification (see PHASE_E_FINAL_REPORT.md section 5) and are
//     NOT migrated by this tool. They are shared/global by design.
//   - TENANT-OWNED business data (the 34 models in
//     src/models/tenantModels/index.js) — THIS is what gets migrated,
//     one physical tenant database at a time.
//
// `tenantScope` describes how to filter legacy rows down to exactly one
// tenant's data:
//   - { direct: true }                     -> WHERE tenantId = :tenantId
//   - { via: [{ column, model }, ...] }     -> chain of FK hops, e.g.
//       ApprovalAssignment -> approvalLevelId -> ApprovalLevel
//                           -> approvalWorkflowId -> ApprovalWorkflow (direct tenantId)
//     Read as: "this table's `column` points at `model`'s `id`; repeat
//     until a model with a direct tenantId is reached." The LAST hop's
//     model must have tenantScope.direct = true (verified at load time
//     by scopeSql.js).
//
// `tier` is the migration order (lower runs first). Ties are broken by
// array order below. This mirrors brief STEP 2 — the order is derived
// from real FK dependencies among the 34 tenant tables (verified via
// `references:` blocks in every model file), NOT the example order in
// the brief.
//
// `selfReferential` flags a column that references the SAME table
// (Document.parentDocumentId) — these need a two-pass insert (insert
// with the column null/omitted, then a second pass to backfill it once
// every row in the table has been assigned its new/preserved id).

const TENANT_TABLE_REGISTRY = [
  // ── Tier 0 — depend only on Tenant/Master-side data ─────────────────
  { model: "User", tier: 0, tenantScope: { direct: true } },
  { model: "CompanyCode", tier: 0, tenantScope: { direct: true } },
  { model: "Category", tier: 0, tenantScope: { direct: true } }, // departmentId -> Master Department, not migrated
  { model: "SapSyncSchedule", tier: 0, tenantScope: { direct: true } },
  { model: "SapSyncSettings", tier: 0, tenantScope: { direct: true } },

  // ── Tier 1 — depend on one Tier-0 tenant table ──────────────────────
  { model: "RefreshToken", tier: 1, tenantScope: { via: [{ column: "userId", model: "User" }] } },
  { model: "AuditLog", tier: 1, tenantScope: { direct: true } }, // has tenantId directly (indexed)
  { model: "Plant", tier: 1, tenantScope: { direct: true } }, // tenantId direct + companyCodeId -> CompanyCode (tier0)
  { model: "DocumentType", tier: 1, tenantScope: { direct: true } }, // tenantId direct + categoryId -> Category (tier0)
  { model: "AIProvider", tier: 1, tenantScope: { direct: true } }, // tenantId direct + createdBy -> User (tier0)
  { model: "ChatSession", tier: 1, tenantScope: { direct: true } }, // tenantId direct + userId -> User (tier0)
  { model: "Notification", tier: 1, tenantScope: { direct: true } }, // tenantId direct, userId -> User nullable

  // ── Tier 2 — depend on Tier-1 tables ────────────────────────────────
  { model: "AISettings", tier: 2, tenantScope: { direct: true } }, // defaultChatProviderId/defaultEmbeddingProviderId -> AIProvider
  { model: "ApprovalWorkflow", tier: 2, tenantScope: { direct: true } }, // categoryId/documentTypeId -> tier0/1, departmentId -> master
  { model: "MetadataTemplate", tier: 2, tenantScope: { direct: true } }, // documentTypeId -> DocumentType (tier1)
  { model: "ChatMessage", tier: 2, tenantScope: { direct: true } }, // sessionId -> ChatSession (tier1)
  { model: "UserAssignment", tier: 2, tenantScope: { direct: true } }, // userId/categoryId/documentTypeId -> tier0/1
  { model: "TenantDepartmentPlant", tier: 2, tenantScope: { direct: true } }, // plantId -> Plant (tier1), rest master
  {
    model: "Document",
    tier: 2,
    tenantScope: { direct: true }, // departmentId/categoryId/documentTypeId/uploadedBy -> tier0/1
    selfReferential: { column: "parentDocumentId" },
  },

  // ── Tier 3 — depend on Tier-2 tables ────────────────────────────────
  { model: "ApprovalLevel", tier: 3, tenantScope: { via: [{ column: "approvalWorkflowId", model: "ApprovalWorkflow" }] } },
  { model: "MetadataTemplateVersion", tier: 3, tenantScope: { via: [{ column: "metadataTemplateId", model: "MetadataTemplate" }] } },
  { model: "PromptHistory", tier: 3, tenantScope: { direct: true } }, // userId -> User, sessionId -> ChatSession (tier1/2)
  { model: "DocumentChunk", tier: 3, tenantScope: { direct: true } }, // documentId -> Document (tier2)
  { model: "Embedding", tier: 3, tenantScope: { direct: true } }, // documentId -> Document (tier2)
  { model: "SapSyncLog", tier: 3, tenantScope: { direct: true } }, // erpConfigId -> master, triggeredBy -> User

  // ── Tier 4 — depend on Tier-3 tables ────────────────────────────────
  {
    model: "ApprovalAssignment",
    tier: 4,
    tenantScope: { via: [{ column: "approvalLevelId", model: "ApprovalLevel" }, { column: "approvalWorkflowId", model: "ApprovalWorkflow" }] },
  },
  { model: "MetadataField", tier: 4, tenantScope: { via: [{ column: "metadataTemplateVersionId", model: "MetadataTemplateVersion" }, { column: "metadataTemplateId", model: "MetadataTemplate" }] } },
  { model: "DocumentApproval", tier: 4, tenantScope: { direct: true } }, // documentId -> Document, approvalWorkflowId -> ApprovalWorkflow
  { model: "TemplateAssignment", tier: 4, tenantScope: { direct: true } }, // documentTypeId/metadataTemplateId/metadataTemplateVersionId
  { model: "SapSyncRetryQueue", tier: 4, tenantScope: { direct: true } }, // sapSyncLogId -> SapSyncLog (tier3)

  // ── Tier 5 — depend on Tier-4 tables ────────────────────────────────
  {
    model: "OcrAlias",
    tier: 5,
    tenantScope: {
      via: [
        { column: "metadataFieldId", model: "MetadataField" },
        { column: "metadataTemplateVersionId", model: "MetadataTemplateVersion" },
        { column: "metadataTemplateId", model: "MetadataTemplate" },
      ],
    },
  },
  { model: "DocumentMetadata", tier: 5, tenantScope: { via: [{ column: "documentId", model: "Document" }] } },
  { model: "ApprovalHistory", tier: 5, tenantScope: { via: [{ column: "documentApprovalId", model: "DocumentApproval" }] } },
  { model: "ApprovalComment", tier: 5, tenantScope: { via: [{ column: "documentApprovalId", model: "DocumentApproval" }] } },
];

// Sanity checks, run once at require-time so a bad registry edit fails
// loudly at boot instead of silently mis-migrating data later.
(function assertRegistryIntegrity() {
  const seen = new Set();
  for (const entry of TENANT_TABLE_REGISTRY) {
    if (seen.has(entry.model)) {
      throw new Error(`tenantTableRegistry: duplicate entry for model "${entry.model}"`);
    }
    seen.add(entry.model);
    if (!entry.tenantScope || (!entry.tenantScope.direct && !entry.tenantScope.via)) {
      throw new Error(`tenantTableRegistry: "${entry.model}" has no usable tenantScope`);
    }
  }
})();

/** Returns the registry sorted into a safe migration order (tier asc, then declaration order). */
function getMigrationOrder() {
  return [...TENANT_TABLE_REGISTRY].sort((a, b) => a.tier - b.tier);
}

function getEntry(modelName) {
  const entry = TENANT_TABLE_REGISTRY.find((e) => e.model === modelName);
  if (!entry) throw new Error(`tenantTableRegistry: no entry for model "${modelName}"`);
  return entry;
}

module.exports = { TENANT_TABLE_REGISTRY, getMigrationOrder, getEntry };
