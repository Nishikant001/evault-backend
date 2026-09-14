# PHASE B — Tenant Model Factory — Completion Report

## Status: DONE (standalone, not yet wired into the running app)

`defineTenantModels(sequelize)` is built, and instantiates all 34
tenant-owned models against ANY Sequelize connection passed to it —
proven against a real, freshly-created physical MySQL database, not just
module-loaded in isolation. Nothing in the running app calls it yet
(that's Phase E) — same incremental posture as Phase A.

## What was built

| File | Purpose |
|---|---|
| `src/models/tenantModels/{34 files}.js` | Factory version of every tenant-owned model: `module.exports = (sequelize) => sequelize.define(...)` instead of a bound singleton |
| `src/models/tenantModels/index.js` | `defineTenantModels(sequelize)` — instantiates all 34 + wires every tenant-to-tenant association |
| `src/models/masterDb/Department.js`, `ErpConfig.js`, `TenantDepartment.js` | Two more models moved to the Master DB (see below) |
| `src/migrations/master/2026081201{00-06}-*` | 3 new master migrations: `erp_configs`, `departments`, `tenant_departments`, with real enforced FKs |

## How the 34 factory files were produced

Not retyped by hand — mechanically transformed from the legacy files
with a script that only touches the require/export wrapper:
```
const sequelize = require("../config/database");        →  (removed)
const X = sequelize.define(                              →  module.exports = (sequelize) => sequelize.define(
module.exports = X;                                       →  (removed)
```
Verified with `diff` against the originals: the only differences are
those three wrapper lines, in every file. This eliminates transcription
risk entirely for 34 files' worth of field definitions, ENUMs, JSON
columns, comments, etc.

## Two more models moved to the Master DB, and why

Not something I decided freehand — both calls are directly supported by
comments and structure already in the legacy code:

**`Department`** — the legacy `models/index.js` says outright: *"SuperAdmin
manages Department master (no tenant FK on Department)."* The model has
no `tenantId` column, and `name`/`code`/`sapCode` are unique **across the
whole system**, not per-tenant. That's platform reference data, not
tenant-owned data, by the codebase's own design.

**`ErpConfig`** — has no `tenantId` column either, and the association is
`ErpConfig.hasMany(Tenant)` — one ErpConfig (a SAP/ERP landscape
definition) can be assigned to many tenants via `Tenant.erpConfigId`.
Confirmed by grep: `erpConfigController.js` never filters by tenant.

**`TenantDepartment`** went with them because it's the admin-controlled
grant ("which Departments can tenant X use") and genuinely FKs to both
`tenants` and `departments` — keeping it in the Master DB means that FK
stays real and enforced instead of becoming a dangling cross-database
reference.

`TenantDepartmentPlant` stayed in the tenant model set — it has a real
`tenantId` and FKs to the tenant's own `Plant`/`CompanyCode`, but it also
references the now-master `TenantDepartment`/`Department` by plain
integer (documented, no enforced FK — see below).

## A real bug this phase surfaced: stale cross-database FK metadata

Running `sync({force:true})` for real against a brand new, empty tenant
database failed immediately:
```
Failed to open the referenced table 'tenants'
```
23 of the 34 factory files still carried `references: { model: "tenants" }`
(or `"departments"` / `"erp_configs"` / `"tenant_departments"`) on fields
like `tenantId` — leftover Sequelize FK metadata from when everything
lived in one database. A tenant database has no local `tenants` table to
reference, so Sequelize tried to build a foreign key to a table that
doesn't exist there.

Fixed with a script that removes **only** `references` clauses pointing
at those 4 now-master tables, leaving every genuine intra-tenant-DB FK
(`users`, `documents`, `categories`, `document_types`, `plants`,
`company_codes`, `approval_workflows`, etc.) untouched and still
enforced at the DB level. Verified: after the fix, `sync({force:true})`
against a real MySQL database built all 34 tables cleanly with their
real FKs intact.

**This is now a documented, permanent pattern** in this codebase: any
tenant-DB column that logically points at a Master DB row (`tenantId`,
`departmentId` on `ApprovalAssignment`/`UserAssignment`,
`erpConfigId` on `SapSyncLog`, `departmentId`/`tenantDepartmentId` on
`TenantDepartmentPlant`) is a **plain integer, enforced only at the
application layer**, never a DB-level FK — because a real FK constraint
across two separate physical MySQL databases isn't possible. Each
affected model file has an inline comment noting this.

## What's deliberately NOT reproduced in `defineTenantModels`

Every association the legacy `models/index.js` has from a tenant model
INTO a now-master model (`Tenant`, `Department`, `ErpConfig`,
`TenantDepartment`, and everything from Phase A) is skipped. The FK
*columns* all still exist exactly as before; there's just no live
Sequelize `belongsTo`/`hasMany` for them anymore, since that would
require two different physical connections. Anywhere the app currently
does `SomeModel.findAll({ include: [Tenant] })` (or `Department`, or
`ErpConfig`) needs a two-step lookup instead. That rewire happens at the
actual call sites in Phase E onward — `tenantModels/index.js` has the
full list of skipped associations documented inline, organized the same
way the legacy file was, so it's easy to cross-reference.

## Testing performed

| Layer | Result |
|---|---|
| Syntax (`node -c`) | ✅ All 34 factory files + `index.js` + 3 new master model files + 3 new migrations |
| Field-fidelity check | ✅ `diff` against every legacy original — only wrapper lines differ, confirmed file-by-file |
| Module loading | ✅ `defineTenantModels()` instantiates against a throwaway MySQL `Sequelize` object, all 34 models returned |
| **REAL MySQL — master-side additions** | ✅ Ran 3 new migrations against live `procur_master`; full CRUD through `Department`/`TenantDepartment`/`ErpConfig`, many-to-many eager load (`Tenant.departments`), duplicate-grant correctly rejected by unique constraint |
| **REAL MySQL — tenant factory** | ✅ Created a **fresh physical database** (`procur_tenant_test`) from nothing, ran `defineTenantModels()` + `sync({force:true})` against it — all 34 tables + associations built with zero errors |
| Deep association tests | ✅ Self-referential `Document` version chain, multi-alias `User↔Document` (uploader/checkedOutBy/checkedInBy), RAG chain (`DocumentChunk`/`Embedding`), all through real inserts + eager loads |
| Intra-tenant FK enforcement | ✅ `Document.create({ uploadedBy: 999999 })` correctly rejected (`SequelizeForeignKeyConstraintError`) |
| Four-stack coexistence | ✅ legacy `models/index.js`, legacy `models/master.js` shim, Phase A `masterDb/`, Phase B `tenantModels/` all `require()` together with zero conflicts |
| Regression check | ✅ `git status` diff is 100% new files + one modified file (`masterDb/index.js`, additive only) |

Test database (`procur_tenant_test`) was dropped after testing — it was
throwaway, not part of the deliverable.

## Next: Phase C — Tenant Connection Manager

`defineTenantModels()` is proven correct but nothing calls it yet. Phase
C is what makes it useful: given a tenant's DB config (from the Master
DB's `TenantDatabase` row), create/cache/reuse a real per-tenant
Sequelize connection, call `defineTenantModels()` against it, and manage
connection lifecycle (idle cleanup, graceful shutdown, concurrency-safe
creation so two simultaneous requests for the same tenant don't open two
connections).
