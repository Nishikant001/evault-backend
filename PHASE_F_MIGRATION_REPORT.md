# Phase F — Legacy Shared-DB → Tenant-DB Data Migration — Final Report

**Scope discipline, stated up front:** this phase does not touch the tenant
connection manager (Phase C), tenant provisioning (Phase D), the tenant
resolver/auth (Phase E), wildcard subdomains, or legacy architecture removal.
It reuses all of those unchanged. What follows is STEP 1 → STEP 11 of the
brief, in order, with what was actually built and actually run against a
real MariaDB instance (not simulated) — see section 10.

---

## STEP 1 — Complete audit

### 1.1 Legacy vs. Master vs. Tenant classification (verified, not assumed)

Read every model's `references:` block and every association in
`src/models/index.js`, then cross-checked programmatically against
`src/models/tenantModels/index.js` (34 factory-defined models) and
`src/models/masterDb/index.js` (12 models). Result, confirmed by a script
that diffs `rawAttributes` and `getTableName()` between every legacy model
and its tenant counterpart: **0 mismatches across all 34 tenant models** —
same columns, same table names, both sides. This is what makes a direct
`dataValues` copy safe.

**Master-side (NOT migrated by this tool — already shared/global):**
Tenant, TenantDatabase, Plan, PlanFeature, Subscription, SubscriptionHistory,
OtpVerification, Department, TenantDepartment, ErpConfig, GlobalUserIndex,
SuperAdmin.

**Tenant-owned (34 models — what this tool migrates, one physical tenant
database at a time):** User, RefreshToken, AuditLog, CompanyCode, Plant,
Category, DocumentType, Document, ApprovalWorkflow, ApprovalLevel,
ApprovalAssignment, DocumentApproval, ApprovalHistory, ApprovalComment,
UserAssignment, SapSyncLog, SapSyncRetryQueue, SapSyncSchedule,
SapSyncSettings, MetadataTemplate, MetadataTemplateVersion, MetadataField,
OcrAlias, DocumentMetadata, TemplateAssignment, AIProvider, AISettings,
DocumentChunk, Embedding, ChatSession, ChatMessage, PromptHistory,
Notification, TenantDepartmentPlant.

### 1.2 Tenant ownership: direct vs. derived

Grepped every one of the 34 model files for a `tenantId` column. **25 have
it directly.** The other **9 derive it through a FK chain**, verified from
each file's actual `references:` block, not assumed:

| Table | Derives tenant via |
|---|---|
| RefreshToken | `userId` → User (direct) |
| ApprovalLevel | `approvalWorkflowId` → ApprovalWorkflow (direct) |
| ApprovalAssignment | `approvalLevelId` → ApprovalLevel → `approvalWorkflowId` → ApprovalWorkflow (direct) |
| MetadataTemplateVersion | `metadataTemplateId` → MetadataTemplate (direct) |
| MetadataField | `metadataTemplateVersionId` → MetadataTemplateVersion → `metadataTemplateId` → MetadataTemplate (direct) |
| OcrAlias | `metadataFieldId` → MetadataField → ... → MetadataTemplate (direct) — **3 hops** |
| DocumentMetadata | `documentId` → Document (direct) |
| ApprovalHistory | `documentApprovalId` → DocumentApproval (direct) |
| ApprovalComment | `documentApprovalId` → DocumentApproval (direct) |

### 1.3 Documents / files

`Document.js`'s own header comment states the binary is **never stored
locally** — it lives on the SAP Content Server; the row holds
`sapDocumentId`/`sapPhioId` references only. `src/uploads/` on disk is
empty, confirming this. **Conclusion: there is no physical file migration
in this phase** — Document rows carry only remote references, which copy
as plain column data like everything else. Documented here per brief STEP
6 rather than skipped silently.

### 1.4 Dependency graph → migration tiers

Built from the actual FK columns (see `src/database/legacyMigration/tenantTableRegistry.js`
for the full commented registry), not the brief's own example order:

```
Tier 0: User, CompanyCode, Category, SapSyncSchedule, SapSyncSettings
Tier 1: RefreshToken, AuditLog, Plant, DocumentType, AIProvider, ChatSession, Notification
Tier 2: AISettings, ApprovalWorkflow, MetadataTemplate, ChatMessage, UserAssignment,
        TenantDepartmentPlant, Document
Tier 3: ApprovalLevel, MetadataTemplateVersion, PromptHistory, DocumentChunk,
        Embedding, SapSyncLog
Tier 4: ApprovalAssignment, MetadataField, DocumentApproval, TemplateAssignment,
        SapSyncRetryQueue
Tier 5: OcrAlias, DocumentMetadata, ApprovalHistory, ApprovalComment
```

`Document.parentDocumentId` is self-referential (a document's own prior
version) — handled as a two-pass insert, see STEP 5.

---

## STEP 2 — Migration order

`getMigrationOrder()` in the registry sorts by tier ascending. This is the
literal execution order `legacyToTenantMigrator.js` uses — code, not just
documentation, so the order can't drift from this report.

---

## STEP 3 — Dry-run (read-only)

`--dry-run` calls `dryRunTenant()`, which only ever calls `.count()` and
`.findAll({ attributes: ["id"] })` — **no `.create`/`.update`/`.bulkCreate`
anywhere in that code path.** Verified live (section 10): running the same
dry-run twice in a row produced identical output and zero row-count change
in the destination database.

Report shape, per tenant, per table: source rows, destination rows before,
rows that would be inserted/updated, and conflicts (legacy ids that already
exist at the destination and would be `UPDATE`d rather than newly inserted
on a real run) — matching the brief's own example shape.

---

## STEP 4 — Tenant mapping (Master DB as sole authority)

`eligibleTenantResolver.js` implements this literally: a legacy tenant is
only migrated if **all** of the following already exist —

1. a row in the legacy `tenants` table,
2. a row in `masterDb.Tenant` matched by the natural key `tenantCode`
   (unique on both sides — verified in the audit), and
3. a row in `masterDb.TenantDatabase` for that master tenant with
   `status = "READY"` and a non-null `databaseName`.

**Destination is never taken from `req.body`/CLI free text/a slug someone
types — it is always looked up from `masterDb.TenantDatabase.databaseName`,**
exactly like `TenantConnectionManager` already does for live requests.

Tenants failing any check are **reported, not silently skipped** — see the
"Skipped tenants" block in every dry-run/migrate/verify run.

### Explicit out-of-scope boundary — read this before running against production

A legacy tenant with **no** `masterDb.Tenant` row, or a `TenantDatabase` row
that isn't `READY`, is **not eligible** for this tool. Making it eligible
means running it through the real provisioning pipeline
(`tenantProvisioningService.provisionTenant()`, via
`tenantController.js`'s `provision`/`retryProvisioning` endpoints) — which
creates the master registration, the physical database, and an initial
admin user. The brief's own instructions ("DO NOT recreate tenant
provisioning") place that squarely out of scope here. **This is not a gap
in the tool — it is the correct scope boundary,** and it is exactly the
"Existing-data migration" line item `PHASE_E_FINAL_REPORT.md` section 12
already flagged as its own project. Provision first, then migrate.

---

## STEP 5/6/7 — Data migration, files, ID collisions

- **Chunked, keyset-paginated reads** (`id > lastId ORDER BY id LIMIT
  chunkSize`, default 500, `LEGACY_MIGRATION_CHUNK_SIZE` env override) —
  never loads a full table into memory.
- **Primary keys, foreign keys, timestamps, and status columns are all
  preserved** — rows are copied via `raw: true` reads and inserted with
  every legacy column intact, including `id`.
- **Files (STEP 6):** nothing to migrate — see section 1.3.
- **ID collisions (STEP 7):** every insert is a real
  `bulkCreate(rows, { updateOnDuplicate: [...allColumnsExceptId] })` — a
  legacy id that already exists at the destination gets its columns
  reconciled to the legacy values rather than silently skipped or blindly
  duplicated. The dry-run's "Conflicts" column tells you this count
  *before* it happens. Verified live: a deliberately pre-seeded conflicting
  `User` row (stale name, id already present) was correctly overwritten
  with the legacy row's real data — not duplicated — in the live test run.
- **`Document.parentDocumentId` (self-referential FK):** first pass inserts
  every Document row with this column nulled out; a second pass then
  `UPDATE`s it from the legacy `(id, parentDocumentId)` pairs, once every
  id in the table is guaranteed to exist at the destination. Verified live:
  a 2-document version chain migrated with the link intact.
- **`GlobalUserIndex` backfill:** migrating `User` rows also upserts
  `masterDb.GlobalUserIndex` (email → tenantId/tenantUserId) — this table
  already exists specifically so the real login flow's tier-2 lookup can
  find a tenant's users (see `GlobalUserIndex.js`'s own header comment).
  Skipping this would leave newly-migrated users still resolving through
  the tier-3 *legacy* fallback at login, which defeats the point of
  migrating them. Conflicts (an email already indexed under a *different*
  tenant — a real cross-tenant duplicate-email situation) are reported, not
  silently overwritten.

---

## STEP 8 — Verification

`--verify` (and the auto-run after every real migration) does two things:

1. **Row counts**, table by table, source (scoped) vs. destination.
2. **Referential integrity**, generated automatically from each tenant
   model's own `belongsTo` associations (`tenantModels/index.js`) — for
   every FK, `COUNT(*) WHERE fk IS NOT NULL AND NOT EXISTS (parent row)`.
   This is not hand-picked spot checks; it walks every association the
   tenant model factory itself defines, so it can't drift from the schema
   the way a hardcoded list of "the important FKs" could. Live run produced
   56 such checks for the single seeded tenant, all `= 0`, including the
   brief's own named examples ("Documents with missing Users",
   "Approvals with missing Documents" — see full output in section 10).

---

## STEP 9 — Idempotency

Two independent layers, deliberately redundant:

1. **`bulkCreate` with `updateOnDuplicate`** on every insert — even with no
   checkpoint at all, re-running the whole migration cannot create a
   duplicate row, because the insert is a real `INSERT ... ON DUPLICATE KEY
   UPDATE` on the primary key.
2. **Per-table checkpoints**, stored in a `_legacy_migration_checkpoints`
   table created inside each tenant's own physical database (not a file, not
   the Master DB — see `checkpointStore.js` header for why: a tenant DB
   backup/restore then automatically carries its own migration state).
   `--resume` (the default) skips tables already marked `COMPLETE`;
   `--no-resume` forces a full re-scan of every table, which is still safe
   because of layer 1.

Verified live: ran the full migration, then re-ran it with `--resume`
(everything skipped, verification still clean), then added a new legacy
`User` row and re-ran with `--no-resume` (full re-scan) — the two
already-migrated users were **not** duplicated, and the one new user was
correctly picked up.

---

## STEP 10 — Backup

Before running this against real production data:

1. **Master DB backup** — `mysqldump procur_master`.
2. **Legacy shared DB backup** — `mysqldump sap_dms` (or your `DB_NAME`).
3. **Every target tenant DB backup** — `mysqldump tenant_<id>` for each
   tenant about to be migrated (relevant mainly if a tenant DB already has
   some data in it — see the dry-run's Conflicts column for whether that's
   the case).

This tool does **not** run backups itself and does **not** delete the
legacy database — see STEP 11.

---

## STEP 11 — No legacy removal

Untouched: `src/config/database.js`, every legacy model in `src/models/`,
`authController.js`'s legacy login tier, the tenant resolver's legacy
fallback path, and the legacy shared-DB connection itself. This tool only
*reads* from the legacy connection and *writes* to tenant connections —
it never opens the legacy connection for writes at all.

---

## What was built

| File | Purpose |
|---|---|
| `src/database/legacyMigration/tenantTableRegistry.js` | Declarative table list, tiers, tenant-scope chains (STEP 1/2) |
| `src/database/legacyMigration/scopeSql.js` | Turns a scope chain into a real Sequelize/SQL filter, reading table names from the models themselves |
| `src/database/legacyMigration/eligibleTenantResolver.js` | STEP 4 — Master DB as sole tenant/database authority |
| `src/database/legacyMigration/checkpointStore.js` | STEP 9 — per-tenant, per-table resumability |
| `src/database/legacyMigration/legacyToTenantMigrator.js` | STEP 3/5/6/7/8/9 — dry-run, migrate, verify |
| `src/database/legacyMigration/reportFormatter.js` | CLI report rendering |
| `scripts/migrateLegacyToTenant.js` | CLI entry point |
| `package.json` | 4 new `npm run migrate:legacy-to-tenant:*` scripts |

No existing file was modified except `package.json` (script additions
only).

## Commands

```bash
# Dry-run everything — read-only, shows what WOULD happen
npm run migrate:legacy-to-tenant:dry-run
node scripts/migrateLegacyToTenant.js --dry-run --all-tenants

# Dry-run one legacy tenant by id
node scripts/migrateLegacyToTenant.js --dry-run --tenant=42

# Migrate one tenant (resumable by default)
node scripts/migrateLegacyToTenant.js --tenant=42

# Migrate one tenant, forcing a full re-scan instead of resuming
node scripts/migrateLegacyToTenant.js --tenant=42 --no-resume

# Migrate every eligible tenant
npm run migrate:legacy-to-tenant:all

# Verify only, no writes (row counts + referential integrity)
node scripts/migrateLegacyToTenant.js --verify --tenant=42
npm run migrate:legacy-to-tenant:verify
```

`--tenant=<id>` is always the **legacy** tenant id (what `Document.tenantId`
etc. actually reference), since that's what an operator running this
migration actually has in hand.

## Conflict report format

Emitted inline in the dry-run/migrate output, one row per table:
`Table | Source rows | Dest (before) | Would insert/update | Conflicts`.
`Conflicts` = legacy ids already present at the destination (would be
`UPDATE`d, not duplicated). `GlobalUserIndex` conflicts (cross-tenant
duplicate email) are printed individually under the `User` table's row.

## Rollback procedure

1. Do not delete the legacy database (this tool never does).
2. If a tenant's migration needs to be undone: restore that tenant's
   physical database from the STEP 10 backup (or, if no backup was taken
   because it was a first-time migration into an empty tenant DB, simply
   `DROP DATABASE tenant_<id>` and re-provision — no legacy data was
   modified, so nothing is lost).
3. `masterDb.GlobalUserIndex` rows created by a rolled-back migration
   should be deleted for that `tenantId` before re-attempting.
4. The legacy shared DB remains the source of truth throughout — the
   tenant resolver's existing legacy-fallback path continues serving that
   tenant's traffic unaffected by a rollback.

---

## STEP 10 (live verification — brief's own closing instruction)

*"Do not claim migration is successful without actually running
verification."* This was run against a **real MariaDB 10.11 instance**,
not simulated:

1. Built the legacy schema and Master DB schema from the actual models
   (`sequelize.sync`).
2. Seeded 3 legacy tenants: one fully provisioned (Master `Tenant` +
   `TenantDatabase` `READY`), one provisioned but `TenantDatabase` still
   `PROVISIONING` (must be skipped), one with no Master-side row at all
   (must be skipped as `NOT_PROVISIONED`).
3. Seeded real legacy business data for the eligible tenant spanning
   **every tier**, including the 3-hop `OcrAlias` chain and a 2-document
   `parentDocumentId` self-reference — 21 rows across 34 tables.
4. Pre-seeded one deliberately conflicting row directly in the tenant DB.
5. Ran `--dry-run --all-tenants`: correctly listed both skip reasons,
   reported 21 source rows and exactly 1 conflict, **and wrote nothing**
   (row counts confirmed unchanged via a direct query afterward).
6. Ran the real migration for the eligible tenant: all 21 rows migrated,
   the pre-seeded conflict was overwritten (not duplicated), the
   self-referential `parentDocumentId` was correctly backfilled,
   `GlobalUserIndex` was populated for both migrated users.
7. Ran verification: **34/34 tables matched row counts, 56/56 referential
   integrity checks = 0.**
8. Re-ran the migration with `--resume`: every table skipped via
   checkpoint, verification still clean.
9. Added one new legacy user, re-ran with `--no-resume` (forced full
   re-scan): the 2 already-migrated users were **not** duplicated, the 1
   new user was picked up correctly.

Full command transcripts are reproducible from the seed script pattern
described above; the sandbox database used for this test run has since
been dropped and `.env`/`src/config/config.json` restored to their
original (production-pointing) values — **nothing in this repository's
runtime configuration was changed by this phase.**

---

## STOP

Per the brief: this phase is complete. Not proceeding to legacy removal or
wildcard subdomain work.
