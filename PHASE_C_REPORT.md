# PHASE C — Tenant Connection Manager — Completion Report

## Status: DONE (standalone, not yet wired into the running app)

`src/services/tenantConnectionManager.js` — given a `tenantId`, returns a
real `{ sequelize, models }` pair for that tenant's own physical
database, creating it on first use, caching it, and cleaning it up when
idle. This is the piece that makes Phase B's `defineTenantModels()`
actually get called. Nothing in the running app calls this yet (Phase E).

## Design decisions

**Tenant DB connection template (`TENANT_DB_HOST/PORT/USER/PASSWORD`).**
`TenantDatabase` (Phase A) only stores a `databaseName` — no host/port/
credentials columns. There's no evidence anywhere in the codebase of
tenants living on different physical MySQL servers, so the reasonable
default (matching the brief's own example — `procur_tenant_a`,
`procur_tenant_b`, same server, different names) is: one shared
host/port/credentials template, one distinct database name per tenant,
looked up from the Master DB at connection time. Falls back to
`MASTER_DB_*` if unset, same pattern as Phase A/B. If tenants actually
need per-tenant distinct credentials or hosts later, that's a
`TenantDatabase` schema addition, not a connection-manager redesign.

**Concurrency safety via a promise cache, not a lock.** A `pending` map
(`tenantId -> Promise`) means if 10 requests for the same not-yet-connected
tenant arrive simultaneously, the 2nd through 10th all await the *same*
in-flight promise instead of racing to open 10 physical connections.
Verified for real (see below) — 10 concurrent calls, exactly 1
`authenticate()` call.

**Idle sweep, not per-request TTL checks.** A `setInterval` (unref'd, so
it can't keep a process alive on its own) periodically scans the cache
and closes anything unused past `TENANT_DB_IDLE_TIMEOUT_MS` (default 30
min, sweep every 5 min, both env-overridable). Verified for real with a
short timeout: the connection is not just evicted from the cache but
genuinely `.close()`'d — a subsequent query against the old handle fails.

**Errors are typed, not generic.** `TenantProvisioningError` with a
`.code` of `NOT_FOUND` / `NOT_READY` / `CONNECTION_FAILED`, so Phase E's
tenant resolver / auth middleware can return the right HTTP status
(404 vs 503 vs 500) instead of a generic 500 for every failure mode.

**A failed connection attempt doesn't get stuck.** If `authenticate()`
fails, the broken connection is closed and the `pending` cache entry is
removed — the *next* call retries cleanly rather than being stuck
awaiting an already-rejected promise forever.

## What's NOT here (by design, deferred to later phases)

- **No cross-process cache sharing.** If the app runs as multiple Node
  processes (cluster/PM2), each process manages its own connection
  cache independently. There's no evidence of a clustering requirement
  in the codebase, so I didn't build a Redis-backed shared cache for a
  need that doesn't (yet) exist — flagging this now in case it matters
  for your deployment target.
- **No wiring into `app.js`'s shutdown handlers.** `closeAllConnections()`
  exists and is tested, but nothing calls it on `SIGTERM`/`SIGINT` yet —
  that's part of Phase E, when `app.js` actually gets touched.

## Testing performed — REAL MySQL, not mocked

All of the following ran against actual physical MySQL databases created
fresh for this test (`procur_tenant_c1`, `procur_tenant_c2`), with real
`Tenant`/`TenantDatabase` rows seeded in the live `procur_master` DB:

| Scenario | Result |
|---|---|
| `NOT_FOUND` (no `TenantDatabase` row) | ✅ Correctly thrown with `.code === "NOT_FOUND"` |
| `NOT_READY` (status still `PROVISIONING`) | ✅ Correctly thrown with `.code === "NOT_READY"` |
| Successful connection | ✅ Real `authenticate()` succeeds, 34 tenant models returned |
| Cache reuse | ✅ Second call for the same tenant returns the *same* `Sequelize` instance |
| **Concurrency safety** | ✅ 10 simultaneous `getTenantConnection()` calls for a brand-new tenant → all resolve to the same instance, and the real MySQL `authenticate()` was called **exactly once** (verified by monkey-patching `Sequelize.prototype.authenticate` to count calls) |
| Explicit close | ✅ `closeTenantConnection()` removes from cache; subsequent call opens a genuinely new instance |
| **Idle sweep** | ✅ With `TENANT_DB_IDLE_TIMEOUT_MS=500`/`SWEEP_INTERVAL_MS=300`, an idle connection is evicted automatically, and the old handle's `.authenticate()` afterward fails (proving it was really closed, not just unmapped) |
| Graceful shutdown | ✅ `closeAllConnections()` empties the cache and stops the sweep timer |
| Four-model-stack + connection manager coexistence | ✅ Legacy `models/index.js`, legacy shim, `masterDb/`, `tenantModels/`, and `tenantConnectionManager.js` all `require()` together with zero errors |

Test databases and seed rows were cleaned up after testing — throwaway,
not part of the deliverable.

## Regression check

`git status` diff: 1 new file
(`src/services/tenantConnectionManager.js`) + additive-only lines in
`.env`. Nothing in `app.js`, `authMiddleware.js`, or any controller/
service touched.

## Next: Phase D — Tenant Database Provisioning

This is where things start becoming real end-to-end: update the
registration flow (`OTP → Company → Tenant → User`) to actually run
`CREATE DATABASE`, run tenant migrations against it, create the tenant's
first admin user in the new tenant DB, and flip `TenantDatabase.status`
from `PROVISIONING` to `READY` — which is exactly the precondition
`tenantConnectionManager` already checks for. Phase D needs a real
tenant migration set to run, though, which doesn't fully exist yet
(currently only `tenantModels/` factory definitions + `sync()`-based
table creation was used in Phase B's tests) — I'll need to either
generate tenant migrations from the 34 factory models or use
`sync({alter:true})` per-tenant the way the legacy app does today for
the shared DB. Flagging that choice for Phase D rather than deciding
silently, since your Phase F explicitly calls for real tenant migrations,
not just `sync()`.
