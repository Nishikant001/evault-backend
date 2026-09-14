# Enterprise SAP DMS Backend — Multi-Tenant SAP Integration Refactor

## 1. Summary

The backend's SAP integration has been converted from a single-customer
(Golyan-only), hardcoded implementation into a **metadata-driven,
per-tenant configurable** architecture. Onboarding a new SAP customer with
different EntitySet names, field/property names, and FunctionImport names
now requires **only a new `ErpConfig` row** — no backend code changes.

No existing API, authentication flow, document workflow, or business
logic was removed or changed in behavior for the current tenant (Golyan).
Every new capability is additive and falls back to the exact legacy
constants when a tenant doesn't configure an override.

---

## 2. Old Architecture (before this refactor)

- `ErpConfig` (per-tenant row: baseUrl, auth, apiKey, sapClient) already
  existed — **connection-level** multi-tenancy was already in place.
- But everything *above* the connection was hardcoded and **global**,
  shared by every tenant:
  - `constants/sapSyncConstants.js` — `SAP_SYNC_ENTITY_SETS` hardcoded
    `DepartmentSet` / `CategorySet` / `DoctypeSet` / `DocumentMetaSet`
    (and was missing a `const`, silently leaking onto the Node global
    object — a real bug, now fixed).
  - `constants/sapSyncConstants.js` — `FIELD_CANDIDATES` hardcoded a fixed
    probe-list of field-name spellings per entity (`DeptCode`, `CatCode`,
    `DtypeCode`, ...), with no way for a tenant to add its own.
  - `sapService.js` — FunctionImport names `GenerateUploadUrl`,
    `ConfirmUpload`, `UploadDocumentXstring`, and the upload response
    property names `Documentid` / `Uploadurl` / `Phioid`, were literal
    strings baked into the request/response code.
  - `services/masterDataService.js` + `config/sapConfig.js` — a
    **second**, entirely separate SAP connection read from process env
    vars (`SAP_BASE_URL` / `SAP_USERNAME` / `SAP_PASSWORD`), bypassing the
    per-tenant `ErpConfig` model completely, with the EntitySet names
    (`DepartmentSet`, `CategorySet`) hardcoded in the controller.

A second SAP customer exposing `DivisionCode` instead of `DeptCode`, or
`DepartmentMaster` instead of `DepartmentSet`, or `UploadDocument` instead
of `GenerateUploadUrl`, would have required editing multiple files.

---

## 3. New Architecture

### 3.1 Canonical internal model (unchanged, now enforced end-to-end)
Business logic already spoke in canonical terms (`code`, `name`,
`departmentCode`, `categoryCode`, `documentTypeCode`, `sapDocumentId`,
`fileName`, `description`, `hasOriginal`, `mimeType`, `createdOn`) via
`sapSyncFieldMap.js`. This refactor makes sure that mapping layer is the
**only** place raw SAP field names are read, for every tenant.

### 3.2 Tenant SAP Configuration (extended)
`ErpConfig` gained six new, all-nullable columns (migration
`20260723010000-add-dynamic-sap-mapping-to-erp-configs.js`):

| Column | Purpose |
|---|---|
| `metadataUrl` | Override for the `$metadata` document URL |
| `odataVersion` | OData version this tenant speaks (`v2` default) |
| `entitySetMap` | Logical entity → actual EntitySet name |
| `fieldMap` | Per-entity logical field → actual property name |
| `functionMap` | Logical operation → actual FunctionImport name (+ response field names) |
| `metadataSnapshot` / `metadataFetchedAt` | Cached last metadata discovery result |

A tenant that leaves these empty gets **exactly** today's Golyan behavior.

### 3.3 Dynamic Field / EntitySet / Function Mapping
New module **`services/sapEntityResolver.js`** is the single resolution
point business logic calls into:

- `resolveEntitySet(erpConfig, logicalEntity)` — tenant override →
  legacy `SAP_SYNC_ENTITY_SETS` default.
- `resolveFunctionName(erpConfig, logicalFunction)` — tenant override →
  legacy default (`GenerateUploadUrl` / `ConfirmUpload` /
  `UploadDocumentXstring`).
- `resolveUploadResponseFields(erpConfig)` — tenant override → legacy
  default (`Documentid` / `Uploadurl` / `Phioid`).
- `resolveFieldCandidates(erpConfig, logicalEntity, logicalField)` — the
  tenant's own field name (if configured) tried **first**, then every
  legacy candidate spelling — so a new tenant's exact field name is
  matched immediately, while any old tenant's field-guessing keeps working
  unchanged.

`sapSyncFieldMap.js`'s `mapDepartment` / `mapCategory` / `mapDocumentType`
/ `mapDocumentMeta` now take an optional `erpConfig` second argument and
route through this resolver; called with no `erpConfig`, behavior is
byte-for-byte identical to before.

### 3.4 Metadata Discovery (Step 7)
New module **`services/sapMetadataService.js`**:
- `fetchMetadataXml(erpConfig)` — GETs `$metadata` using the tenant's own
  connection (`erpService.createClient`), honoring `metadataUrl` override.
- `parseMetadata(xml)` — dependency-free regex-based EDMX reader,
  extracting `EntityTypes` (name, key, properties), `EntitySets` (name →
  entityType), and `FunctionImports` (name, HTTP method, parameters,
  return type). Verified against a representative OData v2 `$metadata`
  sample.
- `discoverMetadata(erpConfig)` — fetch + parse in one call.

### 3.5 Validation Layer (Step 8)
`sapMetadataService.validateTenantMapping(erpConfig, metadata?)` checks
that every required logical EntitySet (`DEPARTMENT`, `CATEGORY`,
`DOCUMENT_TYPE`, `DOCUMENT`) and FunctionImport (`upload`, `confirm`,
`uploadXstring`) — as resolved for that tenant — actually exists in the
discovered `$metadata`, returning `{ valid, errors[], warnings[] }` instead
of letting a sync job fail at runtime on a missing property.

Exposed via two new SuperAdmin-only endpoints on the existing
`erp-configs` resource:
- `GET /api/erp-configs/:id/metadata` — runs discovery, caches the
  snapshot on the `ErpConfig` row, returns it.
- `POST /api/erp-configs/:id/validate` — runs the validation layer and
  returns the result.

### 3.6 SAP Services refactored to use the resolver
- `sapService.js` — `generateUploadUrlViaBatch`, `confirmUpload`, and
  `uploadDocumentXstring` now resolve their FunctionImport name and
  response field names from `erpConfig` instead of hardcoding them.
  `fetchEntitySet(erpConfig, entitySetName)` was already generic and is
  unchanged.
- `sapMasterSyncService.js`, `sapDocumentSyncService.js`,
  `sapHierarchyResolverService.js` — every `SAP_SYNC_ENTITY_SETS.X`
  literal reference replaced with `resolveEntitySet(erpConfig, "X")`, and
  every `mapDepartment/mapCategory/mapDocumentType/mapDocumentMeta(rec)`
  call now also passes `erpConfig`.
- `masterDataService.js` / `masterDataController.js` (`/api/master-data/*`)
  — previously the one place that **bypassed** the tenant architecture
  entirely (a single global SAP connection from env vars, hardcoded
  EntitySet names). Rewritten to resolve the caller's tenant `ErpConfig`
  and pass a resolver-resolved EntitySet name, with the exact same
  request/response contract preserved for the frontend.

---

## 4. Files Changed

### Added
- `src/services/sapEntityResolver.js` — canonical mapping resolver
- `src/services/sapMetadataService.js` — metadata discovery + validation
- `src/migrations/20260723010000-add-dynamic-sap-mapping-to-erp-configs.js`

### Modified
- `src/constants/sapSyncConstants.js` — fixed missing `const` global leak;
  added `SAP_SYNC_FUNCTION_IMPORTS` / `SAP_UPLOAD_RESPONSE_FIELDS` legacy
  defaults
- `src/models/ErpConfig.js` — 6 new nullable columns
- `src/services/sapSyncFieldMap.js` — tenant-aware field resolution
- `src/services/sapService.js` — dynamic FunctionImport + response field
  names
- `src/services/sapMasterSyncService.js` — dynamic EntitySet resolution
- `src/services/sapDocumentSyncService.js` — dynamic EntitySet resolution
- `src/services/sapHierarchyResolverService.js` — dynamic EntitySet
  resolution
- `src/services/masterDataService.js` — rewritten to be tenant-aware
- `src/controllers/masterDataController.js` — rewritten to resolve tenant
  `ErpConfig` and dynamic EntitySet names
- `src/controllers/erpConfigController.js` — accepts new mapping fields on
  create; added `discoverMetadata` / `validateMapping`
- `src/routes/erpConfigRoutes.js` — added `/metadata` and `/validate`
  routes

### Removed (dead code)
- `src/config/sapConfig.js` — the single global env-based SAP connection
  it exposed was used ONLY by the old `masterDataService.js`; once that
  became tenant-aware, this file had zero remaining references and was
  the exact single-customer anti-pattern this refactor targets.

Nothing else in the codebase (auth, document workflow, approval engine,
audit log, OCR, retry queue, scheduler, checkin/checkout, etc.) was
touched.

**Known, intentionally-untouched duplication:** `getErpConfigForTenant`
is implemented near-identically in three places (`documentController.js`,
`sapFinalizationService.js`, and now `masterDataController.js`, plus a
`SAP`-type-checking variant `getSapErpConfigForTenant` in
`sapMasterSyncService.js`). A prior session deliberately kept this
duplicated rather than extracting a shared utility, to avoid touching
already-working files. This refactor followed that same convention for
consistency; consolidating it into one `utils/getErpConfigForTenant.js` is
a safe, low-risk follow-up if desired.

---

## 5. Dynamic Mapping Flow (runtime)

```
sapMasterSyncService.syncDepartments(erpConfig)
        │
        ▼
resolveEntitySet(erpConfig, "DEPARTMENT")
   ├─ erpConfig.entitySetMap.DEPARTMENT set?  → use it
   └─ else                                    → "DepartmentSet" (legacy default)
        │
        ▼
SapService.fetchEntitySet(erpConfig, <resolved EntitySet name>)
        │
        ▼
mapDepartment(rawRecord, erpConfig)
        │
        ▼
resolveFieldCandidates(erpConfig, "DEPARTMENT", "code")
   ├─ erpConfig.fieldMap.DEPARTMENT.code set? → try it FIRST
   └─ then legacy candidates: DeptCode, DepartmentCode, Departmentcode, Code
        │
        ▼
canonical { code, name, description, status }  →  unchanged business logic
```

## 6. Metadata Discovery + Validation Flow

```
POST /api/erp-configs   (create tenant, minimal: name/erpType/baseUrl/auth)
        │
GET /api/erp-configs/:id/metadata
        │  fetchMetadataXml → parseMetadata → cache on ErpConfig.metadataSnapshot
        ▼
[Admin fills in entitySetMap / fieldMap / functionMap using the discovered names]
        │
PUT /api/erp-configs/:id   (save the mapping)
        │
POST /api/erp-configs/:id/validate
        │  resolves every required EntitySet/FunctionImport for this tenant
        │  checks each exists in the (re-)discovered metadata
        ▼
{ valid: true }  → tenant is ready for Master Sync / Document Sync
{ valid: false, errors: [...] }  → fix the mapping before running a sync
```

## 7. Tenant Configuration Flow (end-to-end, new customer)

1. `POST /api/erp-configs` with the new customer's `baseUrl` / `authType`
   / credentials (erpType: "SAP").
2. `GET /api/erp-configs/:id/metadata` to discover their actual
   EntitySets / properties / FunctionImports.
3. `PUT /api/erp-configs/:id` with `entitySetMap` / `fieldMap` /
   `functionMap` built from what was discovered (e.g.
   `{"DEPARTMENT":"DepartmentMaster","CATEGORY":"Categories","DOCUMENT_TYPE":"Documents"}`).
4. `POST /api/erp-configs/:id/validate` to confirm everything resolves.
5. Assign the `ErpConfig` to a `Tenant` (existing `tenantController.js`
   flow, unchanged).
6. Run Master Sync / Document Sync as normal — every sync service now
   reads this tenant's mapping automatically.

No file in `src/services/sap*.js` needs to change for this new customer.

## 8. Future Extension Guide

- **A tenant with completely custom field names not on the legacy probe
  list**: set `fieldMap.<ENTITY>.<field>` — it's tried before every legacy
  candidate.
- **A tenant whose upload flow doesn't use FunctionImports at all (a
  different OData v4 create-entity flow, say)**: `sapService.js`'s three
  upload methods are the extension point; add a new resolver-aware method
  following the same `resolveFunctionName` / `resolveUploadResponseFields`
  pattern used by the existing three.
- **OData v4 tenants**: `ErpConfig.odataVersion` is already reserved for
  this; `sapMetadataService.parseMetadata` currently targets EDMX/OData v2
  `$metadata` shape — a v4 tenant would need a small additional branch in
  `parseMetadata` (CSDL JSON is also valid for v4 and would be an
  even simpler addition), without touching any calling code.
- **Consolidating the three `getErpConfigForTenant` copies**: see the
  "Known, intentionally-untouched duplication" note in Section 4.

## 9. Validation Performed

- `node -c` syntax-checked all 14 added/modified files — all pass.
- Loaded every new/modified module in isolation (`sapEntityResolver`,
  `sapSyncFieldMap`, `sapMetadataService`, `sapService`,
  `sapSyncConstants`, and the full `erpConfigRoutes` /
  `masterDataRoutes` require chains) — no load-time errors.
- Functionally exercised `resolveEntitySet` / `resolveFunctionName` /
  `resolveFieldCandidates` with (a) no tenant overrides — confirmed
  byte-identical output to the old hardcoded Golyan constants, and (b) a
  simulated new-tenant config with different EntitySet/field/function
  names — confirmed correct overrides and correct fallback for the
  functions that tenant didn't override.
- Fed a representative OData v2 `$metadata` XML sample through
  `parseMetadata` — correctly extracted EntityType/EntitySet/
  FunctionImport/Parameter structure.
- Ran `validateTenantMapping` against a deliberately incomplete metadata
  snapshot — correctly flagged every missing EntitySet/FunctionImport.

A full DB-backed integration test (running an actual Master Sync against
a live SAP Gateway) was not performed here since no SAP/database
credentials are available in this environment — the migration should be
run (`npx sequelize-cli db:migrate`) and a real sync exercised against
Golyan's SAP system before deploying, to confirm no behavioral drift.
