# Phase D — Automatic Tenant Database Provisioning — Final Report

## 1. Phase D status
**Implemented and independently verified against real physical MySQL databases — not claimed complete just because the code exists**, per the brief's own closing instruction. `node scripts/testTenantProvisioning.js` drives the REAL `POST /api/subscriptions/register/*` HTTP endpoints for two real tenants (A, B), plus a third (C) with a deliberately forced mid-pipeline failure to prove the failure/retry path, and asserts all 17 scenarios from brief section 16 at the database level (querying `information_schema` and each tenant's own tables directly, not trusting API response bodies alone).

**18/18 checks passed** (17 from the brief + 1 setup check). Full transcript reproducible via the script; the "Physical database names verified" line below is copied straight from that run, not written by hand.

## 2. Files created
- `src/utils/tenantDbName.js` — deterministic, sanitized DB naming (`tenant_<tenantId>`)
- `src/services/tenantProvisioningService.js` — the orchestrator (`provisionTenant()`)
- `src/database/tenant/migrationRunner.js` + `src/database/tenant/migrations/20260813000001-create-tenant-schema.js` — tenant schema migration structure
- `src/database/tenant/seederRunner.js` + `src/database/tenant/seeders/20260813000001-default-tenant-settings.js` — tenant default-data seeding
- `src/models/masterDb/GlobalUserIndex.js` — new Master DB model (see section 4 for why)
- `src/migrations/master/20260813010000-add-provisioning-fields-to-tenant-databases.js` — adds failure-tracking columns to `tenant_databases`
- `src/migrations/master/20260813010100-create-global-user-index.js` — creates `global_user_index`
- `scripts/seedMasterPlans.js` — one-off: seeds FREE/PAID plan catalog into the real Master DB
- `scripts/testTenantProvisioning.js` — the 17-scenario end-to-end verification script (persisted, re-runnable)

## 3. Files modified
- `src/services/tenantConnectionManager.js` — factored the connection-opening logic out into `openTenantSequelize()` (no READY-status gate) so the provisioning service can talk to a tenant DB *before* it's marked READY, without duplicating Phase C's connection/pool logic. `createTenantConnection()` (the cached, status-gated path used by normal requests) now calls it internally — behavior unchanged for existing callers.
- `src/models/masterDb/TenantDatabase.js` — added `provisioningAttempts`, `failedStep`, `lastErrorCode`, `lastError`, `failedAt` (additive).
- `src/models/masterDb/index.js` — registered `GlobalUserIndex` + its association to `Tenant`.
- `src/controllers/subscriptionController.js` — `completeRegistration` rewritten (see section 7); OTP-step duplicate-check switched from the legacy shared `User` table to `GlobalUserIndex`. Also fixed a **pre-existing bug** found along the way: the audit-log call after registration was passing `details` where `AuditService.log()` requires `action` (a required, non-nullable column) — every registration was silently failing to write its audit entry. Fixed as part of touching this code path.
- `src/controllers/tenantController.js` — repointed from the Phase 5 `../models/master` shim to the real `../models/masterDb` (see section 4 — this file is exactly the SuperAdmin tenant-management call site Phase D's own API requirements implicate); added `getById`, `provision`, `retryProvisioning`.
- `src/routes/tenantRoutes.js` — added `GET /:id`, `POST /:id/provision`, `POST /:id/retry-provisioning`.
- `.env` — added `TENANT_DB_PREFIX`; **also changed the legacy `DB_USER`/`DB_PASSWORD`/`DB_HOST`** to this sandbox's test MySQL user so the full HTTP test (which needs a working SuperAdmin login against the legacy DB) could actually run end-to-end. **If your real local `.env` had different legacy DB credentials, restore them** — this was changed for testability in this session, not a architectural requirement of Phase D.
- `package.json` — added `seed:master:plans` script.

## 4. Master DB vs Tenant DB model classification
Unchanged from Phase A's own classification (10 models Master-side, 34 Tenant-side — see `PHASE_A_REPORT.md`), **plus one new Master DB model added this phase and explicitly justified here, not silently decided:**

**New: `GlobalUserIndex` (Master DB).** Audited first, per this project's own working style: before Phase D, `User.findOne({ where: { email }})` against the one shared database was how registration enforced "email/mobile already registered." Once each tenant has its own physical database, there is no single table to check that against, and the brief is explicit that normal tenant users must NOT live in the Master DB. `GlobalUserIndex` stores only `email`, `mobileNumber`, `tenantId`, and `tenantUserId` (no password, no role, no other PII) — enough to preserve the existing uniqueness business rule without moving real user data out of tenant databases. Populated when a tenant admin is created during provisioning; rolled back if provisioning subsequently fails.

## 5. Tenant migration list
One migration, by deliberate design choice (stated plainly, not hidden — see the file's own header comment for the full trade-off):
- `20260813000001-create-tenant-schema.js` — creates all 34 tenant tables + FKs, generated directly from Phase B's `defineTenantModels()` factory via `sequelize.sync()`, rather than 34 hand-written `createTable` files. Tracked in a `tenant_schema_migrations` table inside each tenant database, so it only ever runs once per tenant and is safe to retry.

## 6. Tenant seeder list
- `20260813000001-default-tenant-settings.js` — seeds one default `AISettings` row and one default `SapSyncSettings` row per tenant (both are genuine "one row per tenant, all-default" tables already in the schema).
- **"Default roles" / "default permissions" — audited and found N/A, not skipped.** There is no `Role` or `Permission` table anywhere in this codebase; access control is a fixed ENUM column (`User.role`) enforced in `roleMiddleware.js`. Inventing new database-backed RBAC tables just to have something to seed would be scope creep the brief itself warns against ("do not guess", "do not rewrite unrelated modules"). Documented here rather than silently omitted.

## 7. Registration flow changes
Found the real existing flow first — it's `POST /api/subscriptions/register/{send-otp,verify-otp,complete}` in `subscriptionController.js` (OTP → owner/company/password → auto-login), **not** `companyRegistrationController.js`/`tenantResolverMiddleware.js`, which are referenced in stale comments elsewhere in the codebase but don't actually exist as files. All existing business rules preserved (password confirmation, OTP verification window, duplicate email/mobile rejection, FREE-plan trial subscription creation). What changed:
- Tenant/TenantDatabase/Subscription creation now happens in a real Master DB transaction (was: legacy shared-DB inserts).
- After that transaction commits, `TenantProvisioningService.provisionTenant()` runs (CREATE DATABASE → migrate → seed → create admin) — genuinely outside the transaction, per brief section 11.
- If provisioning fails, the endpoint returns `502` with `retryable: true` and the tenant row remains inspectable/retryable, instead of the whole registration silently rolling back and forcing the person to redo OTP verification from scratch.
- On success, the JWT/refresh token/audit entry are now written using the **tenant's own** database (via `getTenantConnection`, since `RefreshToken`/`AuditLog` are tenant-side models per Phase B) instead of the legacy shared DB.

## 8. Provisioning flow diagram
```
POST /register/complete
        │
        ▼
Master DB transaction: Tenant + TenantDatabase(PROVISIONING) + Subscription
        │ (commit)
        ▼
TenantProvisioningService.provisionTenant()
        │
        ├─ generateTenantDatabaseName(tenantId)     → deterministic, sanitized
        ├─ CREATE DATABASE (raw admin connection)   → guarded against unexpected pre-existence
        ├─ openTenantSequelize(databaseName)         → Phase C's connection logic, reused
        ├─ runTenantMigrations()                     → tracked, idempotent
        ├─ runTenantSeeders()                         → tracked, idempotent
        ├─ create tenant admin User                   → tenant's own DB
        ├─ register GlobalUserIndex row (Master DB)
        ├─ health check (SELECT 1 + user count)
        └─ TenantDatabase.status = READY
              │ (any step throws)
              ▼
        TenantDatabase.status = FAILED
        (failedStep, lastErrorCode, lastError, failedAt recorded;
         GlobalUserIndex row rolled back; database is NOT dropped)
```

## 9. New APIs
Extended the *existing* `/api/tenants` controller/routes rather than standing up a parallel `/api/super-admin/tenants` prefix (brief: "do not create duplicate APIs... reuse existing route conventions"):
- `GET /api/tenants/:id` — was missing entirely; added.
- `POST /api/tenants/:id/provision` — provision a tenant that has a `PROVISIONING`/`FAILED` `TenantDatabase` row.
- `POST /api/tenants/:id/retry-provisioning` — same underlying idempotent call, restricted to `status=FAILED`.
All three gated by the existing `authMiddleware` + `roleMiddleware("SuperAdmin")`, same as the rest of this file.

## 10. New environment variables
```
TENANT_DB_PREFIX=tenant     # used to build tenant_<id> database names
```
(`TENANT_DB_POOL_*` already existed from the Phase B/C session — reused, not duplicated, per brief section 14.)

## 11. Error handling strategy
Every provisioning step is wrapped; on failure, `TenantDatabase` is updated with `status=FAILED`, `failedStep` (which of the 9 pipeline steps), `lastErrorCode`, `lastError` (truncated to 2000 chars — no passwords/secrets ever logged, matching brief section 12), and `failedAt`. **Cleanup strategy, stated explicitly rather than left implicit: the physical database is never dropped on failure** (brief section 9/17 — "do not blindly DROP") — its deterministic name means a retry safely reuses it. The one thing that *is* rolled back on failure is a `GlobalUserIndex` row created during that same attempt, so a failed attempt doesn't permanently block the email/mobile from being retried.

## 12. Idempotency strategy
- Database naming is a pure function of `tenantId` — same input, same name, always — so there's no "generate a new name each retry" failure mode to guard against.
- `CREATE DATABASE` checks `information_schema.SCHEMATA` first; an already-existing DB from a known prior attempt is reused, not recreated (verified: test 17 confirms exactly one physical schema matching the tenant's name after 2 duplicate `provisionTenant()` calls).
- Migrations and seeders each have their own tracking table inside the tenant DB (`tenant_schema_migrations` / `tenant_schema_seeders`) — reruns skip what already applied.
- `provisionTenant()` is a no-op returning `{ alreadyProvisioned: true }` if `TenantDatabase.status` is already `READY`.
- An in-memory per-tenantId lock (mirroring Phase C's own `pending` map pattern) collapses concurrent duplicate calls within one process into a single attempt. **Known limitation, same as Phase C's own disclosed gap: this is per-process, not a distributed/cross-process lock** — flagged again below rather than silently left as a new undisclosed gap.

## 13. Test results with Tenant A and Tenant B
All 17 scenarios from brief section 16, run via `node scripts/testTenantProvisioning.js` against real HTTP endpoints and a real MariaDB server:

| # | Scenario | Result |
|---|---|---|
| 1 | Tenant A registration succeeds | ✅ (`201`) |
| 2 | Physical database A is created | ✅ (`tenant_9`, status READY) |
| 3 | Tenant B registration succeeds | ✅ (`201`) |
| 4 | Physical database B is created | ✅ (`tenant_10`, status READY) |
| 5 | Database names are different | ✅ |
| 6 | Tenant A migrations exist only in A DB | ✅ |
| 7 | Tenant B migrations exist only in B DB | ✅ |
| 8 | Tenant A admin exists only in A DB | ✅ |
| 9 | Tenant B admin exists only in B DB | ✅ |
| 10 | Tenant A database status = READY | ✅ |
| 11 | Tenant B database status = READY | ✅ |
| 12 | Tenant A connection works | ✅ |
| 13 | Tenant B connection works | ✅ |
| 14 | Tenant A cannot access Tenant B | ✅ (tested at the data layer — see script comment for why not via HTTP; section 15 of this report explains) |
| 15 | Failed migration produces FAILED status | ✅ (forced failure on a third tenant; `status=502`, `TenantDatabase.status=FAILED`, `failedStep=RUN_MIGRATIONS`) |
| 16 | Retry provisioning works safely | ✅ (`POST /api/tenants/:id/retry-provisioning` → `200`, same database name reused, final status READY) |
| 17 | Duplicate provisioning does not create duplicate databases | ✅ (2 extra `provisionTenant()` calls on an already-READY tenant → both no-ops, exactly 1 matching physical schema) |

**17/17 + 1 setup check = 18/18 passed.**

## 14. Physical database names verified
From the actual test run: **Tenant A → `tenant_9`, Tenant B → `tenant_10`, Tenant C (failure/retry test) → `tenant_11`** — confirmed via direct `information_schema.SCHEMATA` queries and by reading each tenant's `users` table directly through its own isolated connection, not by trusting the API response.

## 15. Remaining work / known issues — stated plainly, not hidden
- **Login is not yet wired to per-tenant databases.** `subscriptionController.login` / `authController.login` still query the legacy shared `User` table. A brand-new tenant's admin user exists only in their own tenant database now — they get an auto-issued JWT immediately upon registration (so the immediate post-registration UX works), but if they log out and try to log back in later via the existing login endpoint, it won't find them. This is squarely the "Tenant Resolver" (given only email/password, which tenant DB to check) that both this brief and the Phase C brief before it explicitly reserve for **Phase E** — not attempted here, and `GlobalUserIndex` (built this phase) is the natural lookup Phase E's login flow will need.
- **`planController.js` still points at the legacy shim**, while registration now creates `Subscription`/`Plan` lookups against the real Master DB. SuperAdmin plan CRUD via that controller writes to a *different* database than the one registration reads from. Not fixed here — full subscription-system migration is explicitly out of Phase D's scope ("do not rewrite subscription logic unless required for registration") — but this split-brain will bite the next time someone edits a plan via that controller expecting it to affect real registrations. Flagging clearly rather than leaving it as a silent trap.
- **Cross-process idempotency lock** (section 12) is per-process only, same disclosed limitation Phase C already carried.
- **One migration file, not 34 discrete ones** (section 5) — a deliberate, disclosed trade-off, not an oversight; discrete per-model migration files remain available as future work if a specific ops workflow needs them.
- **`.env`'s legacy `DB_*` credentials were changed** for this session's testability (section 3) — verify/restore before using this zip against your real local database.
