# PHASE A — Real Master DB Foundation — Completion Report

## Status: DONE (standalone, not yet wired into the running app)

Phase A builds a genuinely separate Master DB — its own connection, its
own models, its own migrations, its own config — as a foundation. Nothing
in the currently-running app (`app.js`, `authMiddleware.js`,
`src/models/index.js`, `src/models/master.js`) has been touched or
rewired yet. That cutover is Phase E, by design, so Phase 5 work keeps
working unmodified while this is built and tested in isolation.

## What was built

| File | Purpose |
|---|---|
| `src/config/masterDatabase.js` | Real, separate `Sequelize` connection to its own physical DB (`MASTER_DB_NAME`), independent of `src/config/database.js` |
| `src/config/masterConfig.js` | env-driven `sequelize-cli` config for the Master DB (no hardcoded credentials, unlike the legacy `config.json`) |
| `src/models/masterDb/Tenant.js` | Real Master DB model, field-identical to legacy `Tenant.js` |
| `src/models/masterDb/TenantDatabase.js` | Real version (not the Phase 5 shim) — defaults to `PROVISIONING`, meant to be driven by a real pipeline (Phase D) |
| `src/models/masterDb/Plan.js`, `PlanFeature.js`, `Subscription.js`, `SubscriptionHistory.js`, `OtpVerification.js` | Real Master DB models, field-identical to their legacy counterparts |
| `src/models/masterDb/index.js` | Master-to-master associations only (see below) |
| `src/migrations/master/2026081201{00-06}00-*.js` | 7 migrations creating all 7 master tables from scratch |
| `package.json` scripts | `migrate:master`, `migrate:master:undo`, `migrate:master:undo:all`, `migrate:master:status` |
| `.env` | Additive `MASTER_DB_*` vars |

## Decisions made, and why

**Directory named `masterDb`, not `master`.** `src/models/master.js` (the
Phase 5 compatibility shim) already exists as a **file**. Node always
resolves a same-named file before a same-named directory, so a
`src/models/master/` directory would have been **silently unreachable**
via `require("../models/master")` — every current caller
(`authMiddleware.js`, `tenantController.js`, `subscriptionController.js`,
`otpService.js`, `subscriptionScheduler.js`) would keep getting the old
shim with zero error. I hit this for real during testing (see below) and
renamed to avoid leaving that landmine in the codebase. Phase E deletes
`src/models/master.js` and repoints those call sites at `masterDb/`.

**Only Tenant, TenantDatabase, Plan, PlanFeature, Subscription,
SubscriptionHistory, OtpVerification were moved.** Your Phase A list also
mentioned Invoice, Payment, License, Admin, and PlatformAuditLog "where
applicable." None of those exist anywhere in the current codebase — no
billing/invoicing feature, no separate SuperAdmin model, no
platform-level audit log distinct from the tenant `AuditLog`. Inventing
new models for features that don't exist would be exactly the "don't
invent business rules" you told me to avoid, so I left them out. If you
want any of them scaffolded now (even empty), say so and I will.

**Master-to-master associations only, nothing crossing into
tenant-operational models.** The legacy `models/index.js` gives `Tenant`
20+ associations into models that are tenant-operational data (`User`,
`Document`, `Category`, `ApprovalWorkflow`, `AIProvider`, `Notification`,
`SapSyncLog`, etc.). Those are **not** reproduced in
`masterDb/index.js`. Once those models move to per-tenant physical
databases (Phase B/C), they're on a different Sequelize connection than
`Tenant` — real cross-database Sequelize associations (and
`include`-based eager loading) don't work. Code that currently relies on
that kind of eager load (e.g. `tenantController.getAll()` doing
`Tenant.findAll({ include: [TenantDatabase] })`) will need a two-step
lookup instead. That rewire is Phase E, but flagging it now since it's
the single biggest behavioral change coming.

**`SubscriptionHistory.performedBy` has no Sequelize association here**
(legacy version aliases it to `User` as `"performer"`). I grepped every
controller/service — that `.performer` alias is never actually read at
query time, only the raw `performedBy` integer is used — so nothing is
lost by leaving it a plain column.

**⚠️ Open question for you before Phase B — where does `User` live?**
`User.role` includes `"SuperAdmin"`, and SuperAdmin rows have
`tenantId: null` — they don't belong to any tenant. But `User` is also
the FK target for `Document`, `AuditLog`, `ApprovalAssignment`,
`RefreshToken`, and everything else that's unambiguously
tenant-operational data, so `User` has to live in the tenant DB for the
real architecture to make sense. That leaves SuperAdmin accounts with no
natural home — they'd need to become a separate Master DB model (e.g.
`Admin`), which is a real behavioral change to `authController.js` /
`authMiddleware.js` (`User.findByPk` currently treats both uniformly),
not something I want to invent unilaterally. I did **not** move `User`
in Phase A for this reason — flagging it now so we can decide the
SuperAdmin design before Phase B (Tenant Model Factory) has to build
around it.

## Testing performed

| Layer | Result |
|---|---|
| Syntax (`node -c`) | ✅ All 17 new files pass |
| Module loading | ✅ `require("./src/models/masterDb")` loads cleanly, all 7 models + `masterSequelize` present, all associations resolve |
| Legacy stack regression check | ✅ `src/models/index.js` and `src/models/master.js` (the shim) still load with zero changes/errors |
| **REAL MySQL** | ✅ **EXECUTED.** Installed MySQL 8.0 in this environment, created a dedicated TCP-auth test user, ran `db:create` + all 7 migrations against a live server. |
| Real schema verification | ✅ `DESCRIBE` on `tenants`/`tenant_databases`/`subscriptions` matches the models exactly, FK on `subscriptions.tenantId`/`planId` present |
| Real CRUD + associations | ✅ Created a Plan → Tenant → TenantDatabase → Subscription → SubscriptionHistory → OtpVerification chain through the actual Sequelize models, eager-loaded `Tenant` with its master associations, all correct |
| Real FK enforcement | ✅ Attempting `TenantDatabase.create({ tenantId: 999999 })` correctly threw `SequelizeForeignKeyConstraintError` |
| Migration rollback/redo | ✅ `db:migrate:undo` then `db:migrate` on the last migration — clean revert and re-apply |
| Physical DB separation | ✅ `SHOW DATABASES` confirms `procur_master` is a distinct database from the tenant/shared DB name (`sap_dms`) |

**Note on the test credentials**: I installed MySQL fresh in this sandbox
(it wasn't there before) and created a throwaway user
(`procur_test`/`ProcurTest123!`) purely to get a real TCP connection
working, since the existing `root@localhost` in a fresh Debian/Ubuntu
MySQL install uses `auth_socket` (no password, socket-only — won't work
for a real app's TCP connection either, that's a pre-existing fact about
this MySQL package, not something Phase A caused). These are placeholder
credentials for verification only — the `.env` comment says so
explicitly. Replace them with real credentials before deploying anywhere
that matters.

## Regression check

`git diff` against baseline is **fully additive** — 17 new files, and
two modified files (`.env`, `package.json`) with only new lines added,
nothing removed or changed. Zero lines touched in `app.js`,
`authMiddleware.js`, `src/models/index.js`, `src/models/master.js`, or
any controller/service/route file. Everything from your "already
completed Phase 5 work" list is untouched and still loads.

## Next

Phase B (Tenant Model Factory) is next in your order, but it directly
depends on resolving the `User`/SuperAdmin question above — building
`defineTenantModels()` means deciding what's IN the tenant model set,
and `User` is the one genuinely ambiguous case. Let me know how you want
to handle SuperAdmin and I'll proceed.
