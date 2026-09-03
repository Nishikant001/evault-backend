# Phase E — Tenant Resolver + Authentication — Final Report

## 1. Phase E status
**Core infrastructure implemented and verified against real physical databases via real HTTP requests — with the scope boundary stated explicitly, per this phase's own closing instruction ("do NOT claim the entire application is migrated if only middleware has been changed").**

What "Tenant Resolver + Authentication" (the phase's own title) means was built and tested end-to-end: `tenantResolverMiddleware.js` exists, `authMiddleware.js` no longer queries the legacy shared DB or blindly sets `req.models = allModels`, SuperAdmin now authenticates against a real Master DB table, and login/refresh/logout correctly dispatch a user to their own physical tenant database. **14/14 scenarios from brief section 11 passed**, run against real HTTP endpoints on a live server with real MariaDB — not simulated.

What was **not** done this phase, disclosed in section 7/12 rather than hidden: most individual tenant *controllers* (beyond the ones already using `req.models` from earlier work) were not mechanically migrated off static `require("../models")` imports. The resolver now makes `req.models` correctly tenant-scoped everywhere `authMiddleware` runs — but a controller that still imports its own models statically bypasses that entirely, tenant-scoped or not. That's real, separately-scoped work (Phase F), not swept up here.

## 2. Tenant Resolver implementation
`src/middleware/tenantResolverMiddleware.js`. Given `req.user` (already JWT-verified by `authMiddleware.js`):
- `role === "SuperAdmin"` → attaches `req.masterModels` only, `next()`. No tenant database touched.
- Tenant user → resolves `tenantId` from the **verified JWT only** (never `req.params`/`req.body`/`req.query` — see file header for why this is the actual security property, not just a convention), loads `Tenant` from the Master DB, checks `status === "ACTIVE"`, loads `TenantDatabase`, checks `status === "READY"`, calls `TenantConnectionManager.getTenantConnection(tenantId)` (Phase C, reused not duplicated), **re-verifies the JWT's userId actually exists and is active inside that tenant's own database** (brief section 2: "do not trust tenantId blindly" — extended here to not trust userId blindly either), then attaches `req.tenant`, `req.tenantDb`, `req.models`, `req.masterModels`.
- **Legacy fallback** (see section 3 finding below): if the tenant predates Phase D — found in NEITHER the new `masterDb.Tenant` table NOR has a `TenantDatabase` row — falls back to the legacy shared-DB models, exactly matching pre-Phase-E behavior for that tenant only. Explicitly logged via `req.legacyTenant = true` so this is inspectable, not silent.

**Design decision, stated plainly:** composed *into* `authMiddleware.js` rather than added as a second middleware every one of the ~26 route files would need to add. Every route already using `authMiddleware` gets full tenant resolution automatically — one audited change point instead of 26 mechanical ones. `tenantResolverMiddleware.js` still exists as its own file, importable/testable independently, exactly as the brief asks.

## 3. Auth changes
- `authMiddleware.js` — rewritten to do ONLY JWT verification (signature + shape), zero database queries. Previously: queried the legacy `User` table on every request and unconditionally set `req.models = allModels`.
- `authController.login` — rewritten as a three-tier resolver: (1) Master DB `super_admins`, (2) Master DB `GlobalUserIndex` → that tenant's own database, (3) legacy shared `User` table, unchanged, as the final fallback for anyone predating Phase D. Stops at the first tier that matches the email.
- `authController.refreshToken` / `logout` — updated to dispatch by the refresh token's own `role`/`tenantId` claims (added to `generateRefreshToken()`'s payload this phase — additive) so revocation happens against the correct database.
- **Bug found and fixed during testing, not assumed away:** the resolver's very first version looked up `masterModels.Tenant.findByPk(tenantId)` and returned "Tenant not found" for every pre-existing tenant, because tenants created before Phase D only ever existed in the *legacy* Tenant table — the new Master DB's `Tenant` table only contains tenants created through the Phase D pipeline going forward. A real end-to-end test against a manually-created legacy tenant (no `TenantDatabase` row, no `masterDb.Tenant` row) caught this as a `403` before the fix, `200` with correct data after. Now the resolver checks `masterDb.Tenant` first and falls back to the legacy `Tenant` table before concluding "not found."

## 4. SuperAdmin handling
New Master DB model `SuperAdmin` (`super_admins` table) + migration + `scripts/seedMasterSuperAdmin.js`, wired into `app.js`'s existing boot sequence alongside (not replacing) the legacy `seedSuperAdmin()`/`seedPlans()` calls. **The legacy shared-DB SuperAdmin row is deliberately not removed** — brief section 3 explicitly says "do not break existing SuperAdmin functionality," and removing it would invalidate anything already depending on that row existing. `login()` checks the new Master DB table first; the legacy row becomes inert (never matched) once the real one exists, without anything needing to be deleted. **Known gap, disclosed:** there is no Master-DB-backed refresh-token store for SuperAdmin yet, so a SuperAdmin's refresh token can't be individually revoked via `logout()` the way a tenant user's can — flagged in section 12.

## 5. Master vs Tenant model classification
Unchanged from Phase A/D's own classification, plus `SuperAdmin` (new, Master DB, this phase). Full current list:

**Master DB:** Tenant, TenantDatabase, Plan, PlanFeature, Subscription, SubscriptionHistory, OtpVerification, Department, TenantDepartment, ErpConfig, GlobalUserIndex, **SuperAdmin**.

**Tenant DB (34 models, unchanged from Phase B):** User, RefreshToken, AuditLog, CompanyCode, Plant, Category, DocumentType, Document, ApprovalWorkflow, ApprovalLevel, ApprovalAssignment, DocumentApproval, ApprovalHistory, ApprovalComment, UserAssignment, SapSyncLog, SapSyncRetryQueue, SapSyncSchedule, SapSyncSettings, MetadataTemplate, MetadataTemplateVersion, MetadataField, OcrAlias, DocumentMetadata, TemplateAssignment, AIProvider, AISettings, DocumentChunk, Embedding, ChatSession, ChatMessage, PromptHistory, Notification, TenantDepartmentPlant.

**No cross-database Sequelize associations exist or were added** — verified by grep; every association in `tenantModels/index.js` and `masterDb/index.js` stays within its own file/database.

## 6. Controllers migrated
None new this phase beyond what `authController.js` itself required (login/refreshToken/logout — see section 3). The ~13 controllers already reading through `req.models` from earlier work (confirmed via `userController.js`, directly exercised by the end-to-end test — see section 10) needed no changes: they automatically became correctly tenant-scoped the moment `authMiddleware` started attaching a real per-tenant `req.models` instead of the shared one. That's the leverage point of the composition decision in section 2.

## 7. Controllers still using global models — full audit
Grepped every controller/service for a top-level `require("../models")`. **Not rewritten this phase** — reported here in full per brief section 7's own template, deferred to Phase F with the classification already done so no guessing is needed later:

| File | Current model source | Required model source | Status |
|---|---|---|---|
| `controllers/erpConfigController.js` | `require("../models")` → `ErpConfig` | `req.masterModels` (ErpConfig is **Master**-side, not tenant) | Not migrated |
| `controllers/documentMetadataController.js` | `require("../models")` → Document, DocumentMetadata, MetadataTemplateVersion, MetadataField, OcrAlias | `req.models` (all tenant-side) | Not migrated |
| `controllers/metadataFieldController.js` | `require("../models")` → MetadataField, MetadataTemplateVersion, MetadataTemplate, OcrAlias | `req.models` (all tenant-side) | Not migrated |
| `controllers/checkInOutController.js` | `require("../models")` → Document, DocumentType, User | `req.models` (all tenant-side) | Not migrated |
| `controllers/sapSyncController.js` | `require("../models")` → Tenant, SapSyncLog, SapSyncRetryQueue | **Mixed**: `Tenant` → `req.masterModels`; `SapSyncLog`/`SapSyncRetryQueue` → `req.models` | Not migrated |
| `controllers/documentTypeController.js` | `require("../models")` → DocumentType, Category | `req.models` (both tenant-side) | Not migrated |
| `controllers/approvalController.js` | `require("../models")` → Document, DocumentApproval, ApprovalHistory | `req.models` (all tenant-side) | Not migrated |
| `services/documentIndexingService.js` | `require("../models")` → Document, DocumentMetadata, DocumentChunk, Embedding | `models` param (tenant-side) | Not migrated |
| `services/summaryService.js` | `require("../models")` → Document, DocumentMetadata, DocumentChunk | `models` param (tenant-side) | Not migrated |
| `services/sapRetryQueueService.js` | `require("../models")` → SapSyncRetryQueue | `models` param (tenant-side) | Not migrated |
| `services/chatService.js` | `require("../models")` → ChatSession, ChatMessage, Document | `models` param (tenant-side) | Not migrated |
| `services/vectorSearchService.js` | `require("../models")` → DocumentChunk, Document, DocumentMetadata | `models` param (tenant-side) | Not migrated |
| `services/aiProviderService.js` | `require("../models")` → AIProvider, AISettings | `models` param (tenant-side) | Not migrated |
| `services/sapHierarchyResolverService.js` | `require("../models")` → Department, Category, DocumentType, TenantDepartment | **Mixed**: `Department`/`TenantDepartment` → `masterModels`; `Category`/`DocumentType` → `models` | Not migrated |
| `services/sapSyncLogService.js` | `require("../models")` → SapSyncLog | `models` param (tenant-side) | Not migrated |
| `services/sapSyncOrchestrator.js` | `require("../models")` → Tenant, ErpConfig, Department | **Mixed**: all three are `masterModels` | Not migrated |
| `services/sapDocumentSyncService.js` | `require("../models")` → Document, Department, Category, DocumentType | **Mixed**: `Department` → `masterModels`; rest → `models` | Not migrated |
| `services/dynamicOcrMappingService.js` | `require("../models")` → DocumentMetadata | `models` param (tenant-side) | Not migrated |
| `services/subscriptionScheduler.js` | `require("../models")` → Subscription, Tenant, User (+ full `allModels`) | **Different category, not a simple swap** — see note below | Not migrated |
| `services/sapSyncScheduler.js` | `require("../models")` → Tenant, ErpConfig, SapSyncSchedule | **Different category, not a simple swap** — see note below | Not migrated |

**Note on the last two:** `subscriptionScheduler.js` and `sapSyncScheduler.js` are `node-cron` background jobs with no HTTP `req` at all — there is no `req.models` to read. Fixing them correctly means iterating over every `READY` tenant and calling `TenantConnectionManager.getTenantConnection()` for each, inside the cron handler itself, not a mechanical import swap like the rest of this table. Flagged as its own line item for Phase F, not lumped in with the others.

`planController.js`, `tenantController.js`, `subscriptionController.js`, `otpService.js`, `subscriptionService.js` are **excluded from this table** — already correctly on `masterModels`/`req.masterModels` from Phase D (or, for `planController.js`, already-known and previously-disclosed split-brain — see `PHASE_D_FINAL_REPORT.md` section 15, still unresolved, not re-litigated here).

## 8. Cross-database lookups identified
From the audit in section 7: `erpConfigController`, `sapSyncController`, `sapHierarchyResolverService`, `sapSyncOrchestrator`, and `sapDocumentSyncService` all mix Master-side (`ErpConfig`, `Tenant`, `Department`, `TenantDepartment`) and Tenant-side data in the same file. None of these currently attempt a cross-database Sequelize `include()` (verified — they're separate queries already, just against the wrong/single connection today); the fix in Phase F is redirecting each query to the correct one of `req.models` / `req.masterModels`, with an explicit two-step lookup (e.g. `document.departmentId` → tenant DB read, then `masterModels.Department.findByPk(departmentId)` → Master DB read) exactly as brief section 8 describes — not a new pattern to invent, just consistent application once Phase F touches these files.

## 9. Routes updated
**None** — by design, see section 2. Every route file already wires `authMiddleware` for protected endpoints; that single change point now performs full tenant resolution for all of them. Verified directly: `GET /api/users` (declared in `userRoutes.js`, unmodified) correctly executed against `tenant_16`/`tenant_17` in the test run (section 10), with zero route-file changes.

## 10. Isolation tests — all 14 scenarios from brief section 11
Run via `node scripts/testTenantResolver.js` against a live server, two tenants provisioned through the real Phase D pipeline, real logins through the rewritten `authController.login`:

| # | Scenario | Result |
|---|---|---|
| 1 | Login Tenant A | ✅ |
| 2-3 | `GET /api/users` executes on Tenant A's own DB | ✅ (API response matched a direct query against `tenant_16.users`) |
| 4-5 | Login Tenant B; verify query executes on Tenant B's DB | ✅ (matched `tenant_17.users`) |
| 6 | Tenant A cannot access Tenant B | ✅ |
| 7 | Tenant B cannot access Tenant A | ✅ |
| 8 | Changing tenantId in request body does not bypass isolation | ✅ (created in caller's own tenant DB regardless of a foreign `tenantId` in the POST body) |
| 9 | Changing tenantId in URL does not bypass isolation | ✅ (`GET /api/tenants/:otherTenantId` as a tenant user → `403`, role-gated before tenantId is ever read) |
| 10 | Inactive Tenant A is rejected | ✅ |
| 11 | Tenant A with FAILED TenantDatabase is rejected | ✅ |
| 12 | SuperAdmin can access Master DB | ✅ |
| 13 | SuperAdmin does not require tenant DB | ✅ |
| 14 | Repeated requests reuse the same tenant connection | ✅ |

**14/14 passed**, plus a manually-verified 15th check outside the brief's own list: a genuinely pre-Phase-D "legacy" tenant (no `masterDb.Tenant` row, no `TenantDatabase` row at all) still logs in and correctly reaches its own data via the legacy-fallback path — this is what caught the bug described in section 3.

## 11. Test results
13/13 in the first run (one test-script measurement bug, not a product bug — see script comments), 14/14 after fixing the test's own warm-up ordering; then the real product bug from section 3 was found via a separate targeted legacy-tenant test, fixed, and the full 14/14 suite re-run clean afterward.

## 12. Remaining work for Phase F
- **Full controller/service migration** — the 20-file audit table in section 7, with the Master/Tenant split already worked out per file so Phase F doesn't need to re-derive it.
- **Background job tenant iteration** — `subscriptionScheduler.js` and `sapSyncScheduler.js` need to loop over all `READY` tenants and resolve a connection per tenant inside the cron handler; not a mechanical fix like the rest.
- **SuperAdmin refresh-token revocation** — no Master-DB-backed store yet (section 4).
- **Existing-data migration** (tracked since Phase D) — every tenant that predates Phase D still runs entirely on the legacy shared database via the fallback path built this phase; moving them onto real physical databases is its own project, not attempted here.
- **`planController.js` split-brain** — carried over from Phase D, still unresolved.
- **Cross-tenant SuperAdmin views** (`userController.js`'s own header comment: `?tenantId=` browsing for SuperAdmin) — noted in that file as needing "cross-tenant connection tooling," not built this phase.
