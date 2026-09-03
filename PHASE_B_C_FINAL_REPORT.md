# Phase B + Phase C — Final Report

## Audit finding, upfront

The uploaded codebase already contained working implementations of both
phases before this session touched anything:

- `src/models/tenantModels/index.js` — `defineTenantModels(sequelize)` (Phase B)
- `src/services/tenantConnectionManager.js` — `getTenantConnection(tenantId)` (Phase C)
- `PHASE_B_REPORT.md` / `PHASE_C_REPORT.md` — reports from that prior work

Per your instruction not to rebuild or rewrite what's already done, this
session did **not** regenerate either. Instead it audited both against
every requirement in the brief, found one real gap, fixed it, and then
independently re-verified all 15 scenarios (plus the pool fix) against a
real MySQL-compatible server — not a re-run of the prior claims, a fresh
test.

---

## 1. Phase B status
**Already complete, unchanged this session.** All 34 tenant-operational
models are defined via a factory function bound to a passed-in
`sequelize` instance, with every intra-tenant association preserved and
every cross-boundary (tenant→master) association intentionally dropped
and documented in the model's own comments. Verified this session with a
real create+read round-trip through the factory models against a live
throwaway database (test #7b below) — not just "it requires without
error."

## 2. Phase C status
**Already complete going in; one real gap found and fixed this session.**
`getTenantConnection()` correctly resolves tenant → database name via
the Master DB, validates status, caches per-tenant, de-duplicates
concurrent first-time connections via a `pending` promise map, sweeps
idle connections, and exposes `closeAllConnections()` for shutdown. The
gap: **no Sequelize connection pooling was configured** — every tenant
connection was created with Sequelize's implicit defaults, and the
brief's requested `TENANT_DB_POOL_MAX/MIN/ACQUIRE/IDLE` env vars didn't
exist anywhere. Fixed (see below).

## 3. Files created
- `scripts/testTenantConnectionManager.js` — persisted, re-runnable test
  script implementing all 15 scenarios from the brief plus a concurrency
  check and a pool-config check. Prior sessions apparently ran ad-hoc
  tests and reported the results but didn't leave a script behind; this
  one is now part of the repo (`node scripts/testTenantConnectionManager.js`).
- `PHASE_B_C_FINAL_REPORT.md` — this file.

## 4. Files modified
- `src/services/tenantConnectionManager.js` — added a `TENANT_DB_POOL`
  object read from env vars and passed as `pool:` into the tenant
  `Sequelize` constructor; exposed it via `getCacheStats()` for
  diagnostics.
- `.env` — added `TENANT_DB_POOL_MAX/MIN/ACQUIRE/IDLE` with Sequelize's
  own defaults (5 / 0 / 30000 / 10000) as values, so behavior is
  unchanged until you tune them.

No controller, route, middleware, or existing model file was touched.

## 5. Models converted to factory
All 34, unchanged this session (see `tenantModels/index.js` for the
full list): User, RefreshToken, AuditLog, CompanyCode, Plant, Category,
DocumentType, Document, ApprovalWorkflow, ApprovalLevel,
ApprovalAssignment, DocumentApproval, ApprovalHistory, ApprovalComment,
UserAssignment, SapSyncLog, SapSyncRetryQueue, SapSyncSchedule,
SapSyncSettings, MetadataTemplate, MetadataTemplateVersion,
MetadataField, OcrAlias, DocumentMetadata, TemplateAssignment,
AIProvider, AISettings, DocumentChunk, Embedding, ChatSession,
ChatMessage, PromptHistory, Notification, TenantDepartmentPlant.

## 6. Models still pending
None from the shared-DB model set are outside the factory — every
tenant-operational model that exists in the legacy `src/models/index.js`
has a factory counterpart. What's *not* modeled here is deliberate, not
pending: 10 models moved fully to the Master DB in Phase A
(Tenant, TenantDatabase, Plan, PlanFeature, Subscription,
SubscriptionHistory, OtpVerification, Department, TenantDepartment,
ErpConfig) and correctly don't appear in `tenantModels/`.

## 7. Connection Manager design
Unchanged from `PHASE_C_REPORT.md`'s own description, which this
session's independent re-test confirms is accurate:
- One `Sequelize` instance per tenant, created lazily on first
  `getTenantConnection(tenantId)` call.
- Tenant → database name resolved server-side from the Master DB's
  `TenantDatabase` row — the client never supplies a raw database name.
- Status gate: only `READY` connects; `PROVISIONING`/`FAILED` throw a
  typed `TenantProvisioningError` (`NOT_FOUND` / `NOT_READY` /
  `CONNECTION_FAILED`).
- Idle connections swept and closed after `TENANT_DB_IDLE_TIMEOUT_MS`
  (default 30 min), sweep runs every `TENANT_DB_IDLE_SWEEP_INTERVAL_MS`
  (default 5 min), both unref'd so they don't block process exit.
- `closeAllConnections()` exists for graceful shutdown; not yet wired to
  `SIGTERM`/`SIGINT` in `app.js` — that's still Phase E, per the
  brief's own "do not implement the complete Tenant Resolver yet."

## 8. Cache design
`Map<tenantId, {sequelize, models, lastUsedAt}>` for established
connections, plus a separate `Map<tenantId, Promise>` for in-flight
first-time connections. The second map is what makes concurrent
first-requests for the same not-yet-connected tenant share one
`authenticate()` call instead of racing — re-verified this session with
10 simultaneous calls (see test 9b: `authenticate()` called exactly
once).

## 9. Pool configuration (fixed this session)
```
TENANT_DB_POOL_MAX=5        // max connections per tenant pool
TENANT_DB_POOL_MIN=0        // min idle connections kept open
TENANT_DB_POOL_ACQUIRE=30000  // ms to wait for a connection before erroring
TENANT_DB_POOL_IDLE=10000     // ms a connection can sit idle before release
```
Note this is **one pool per tenant**, not one pool shared across all
tenants — each cached `{sequelize, models}` entry owns its own pool,
sized identically by these env vars. If some tenants need materially
different pool sizing later, that's a per-tenant override on top of
this, not a redesign.

## 10. Environment variables added
```
TENANT_DB_POOL_MAX=5
TENANT_DB_POOL_MIN=0
TENANT_DB_POOL_ACQUIRE=30000
TENANT_DB_POOL_IDLE=10000
```
(Everything else — `MASTER_DB_*`, `TENANT_DB_HOST/PORT/USER/PASSWORD` —
already existed from Phase A/C and was reused as instructed.)

## 11. Tests performed — real MariaDB, not mocked
Ran via `node scripts/testTenantConnectionManager.js` against a real
MariaDB 10.11 instance, with genuinely separate physical databases
(`procur_tenant_test_a`, `procur_tenant_test_b`, `procur_tenant_test_c`)
and real `Tenant`/`TenantDatabase` rows in a real `procur_master` DB —
all 15 scenarios from the brief, in the brief's own order, plus two
extra checks:

| # | Scenario | Result |
|---|---|---|
| 1 | Master DB connection works | ✅ |
| 2 | Tenant A connection can be created | ✅ |
| 3 | Tenant B connection can be created | ✅ |
| 4 | Tenant A uses database A | ✅ |
| 5 | Tenant B uses database B | ✅ |
| 6 | Tenant A and B Sequelize instances differ | ✅ |
| 7 | Tenant A models bound to Tenant A Sequelize | ✅ |
| 7b | *(extra)* real create+read round-trip through Tenant A's factory models | ✅ |
| 8 | Tenant B models bound to Tenant B Sequelize | ✅ |
| 9 | Repeated Tenant A requests reuse the same connection | ✅ |
| 9b | *(extra)* 10 concurrent first-time requests → 1 `authenticate()` call | ✅ |
| 10 | Invalid tenant is rejected (`NOT_FOUND`) | ✅ |
| 11 | Inactive/PROVISIONING tenant is rejected (`NOT_READY`) | ✅ |
| 12 | READY TenantDatabase connects | ✅ |
| 13 | PROVISIONING TenantDatabase does not connect | ✅ |
| 14 | FAILED TenantDatabase does not connect | ✅ |
| 15 | Master DB stays a fully separate connection/database | ✅ |
| — | *(extra)* `TENANT_DB_POOL_*` env vars actually reach the Sequelize `pool:` option | ✅ |

**18/18 passed.** Also re-ran the full model-stack regression check
(`models/master.js` shim + `masterDb/` + `tenantModels/` +
`tenantConnectionManager.js` all `require()`-ing together) with zero
errors.

## 12. Test results
18/18 (see table above). Full console output is reproducible by running
the checked-in script; nothing here is asserted without that script
having actually produced it in this session.

## 13. Known issues
- **No cross-process cache sharing** (documented already in
  `PHASE_C_REPORT.md`, still true): if the app ever runs as multiple
  Node processes, each has its own connection cache. Not built, because
  there's no evidence of a clustering requirement yet — flagging again
  in case your deployment target needs it.
- **`closeAllConnections()` not wired to `SIGTERM`/`SIGINT`** — exists
  and is tested standalone, but `app.js` doesn't call it yet. That's
  explicitly Phase E territory per the brief.
- **Pool sizing is uniform across all tenants** — fine for now, would
  need a per-tenant override mechanism if some tenants turn out to need
  materially larger/smaller pools.
- The fix in this session (pool config) was additive to an existing
  file; it was not independently re-audited by a second person/process
  beyond this session's own test script.

## 14. Exact next phase required
**Phase D — Tenant Database Provisioning**, unchanged from what
`PHASE_C_REPORT.md` already identified: wire the registration flow
(OTP → Company → Tenant → User) to actually run `CREATE DATABASE`,
run real tenant migrations against it (not just `sync()`), create the
tenant's first admin user in the new tenant DB, and flip
`TenantDatabase.status` from `PROVISIONING` to `READY` — which is
exactly the precondition `tenantConnectionManager` already checks for.
Phase D needs a real tenant migration set generated from the 34 factory
models (or a documented decision to use `sync({alter:true})` per-tenant
instead), which doesn't exist yet.

---

**Not claiming more than was actually done:** Phase B and Phase C were
functionally complete before this session; this session's contribution
was auditing both against the brief, fixing the one real gap (pool
config), and replacing "ad-hoc tests were run and reported" with an
actual persisted, re-runnable, currently-passing test script.
