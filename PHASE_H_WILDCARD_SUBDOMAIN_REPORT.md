# Phase H — Wildcard Subdomain Tenant Routing — Final Report

**Scope discipline, stated up front:** this phase does not redesign the
Master DB + Tenant DB architecture, does not touch tenant provisioning,
does not modify the connection cache (`tenantConnectionManager.js`), and
does not configure DNS. Everything below is additive: with `BASE_DOMAIN`
unset, every request behaves exactly as it did at the end of Phase G
(JWT-only tenant resolution) — verified live, see "Backward compatibility"
below.

---

## 1. Files changed

- **`src/middleware/tenantResolverMiddleware.js`** — EXTENDED (per the
  brief's explicit instruction: "Inspect the existing tenant resolver
  first. Extend it rather than creating duplicate logic."), not
  rewritten. Two additions only:
  1. A hostname/JWT tenantId cross-check (the brief's "JWT Security"
     section), inserted right after the JWT's `tenantId` is read and
     right before the existing Master DB lookup — everything after that
     point is unchanged.
  2. The generic `catch` block's error response was tightened while I
     was in this file: it previously returned raw `error.message` to the
     client, which is exactly the "never expose ... stack trace" leak
     the brief's "Errors" section prohibits. Now logs full detail
     server-side only and returns a generic message.
- **`src/app.js`** — mounts the two new middlewares (see below), replaces
  the static CORS options with the new dynamic validator, adds
  `trust proxy` configuration. No route file changed.
- **`.env`** — two new variables appended (`BASE_DOMAIN`, `TRUST_PROXY_HOPS`),
  both commented out / unset by default so no existing deployment's
  behavior changes just from pulling this code.

## 2. Files created

- **`src/config/tenantRouting.js`** — `BASE_DOMAIN` parsing,
  `RESERVED_SUBDOMAINS` list, DNS-label validation, and the pure
  `extractSlugCandidate()`/`isAssignableSlug()` helpers. No side effects,
  no I/O — kept separate specifically so this logic has one home instead
  of being duplicated between the routing middleware and CORS config.
- **`src/middleware/hostContextMiddleware.js`** — the new piece: Host
  header → tenant slug → Master DB lookup → `req.hostContext`. Mounted
  globally in `app.js`, before all routes.
- **`src/middleware/requestContextMiddleware.js`** — `req.requestId`
  assignment + the one whitelisted `structuredLog()` helper used
  everywhere the brief's "Logging" section applies.
- **`src/config/corsOptions.js`** — dynamic origin validator supporting
  `https://*.<BASE_DOMAIN>` without ever emitting
  `Access-Control-Allow-Origin: *` (impossible together with
  `credentials: true` regardless — see below).
- **`.env.example`** — a secret-scrubbed copy of `.env` for onboarding
  (didn't exist before this phase); also documents the two new variables
  inline.
- **`PHASE_H_WILDCARD_SUBDOMAIN_REPORT.md`** — this file.

## 3. Tenant routing flow (as implemented)

```
Host: acme.app.mydms.com
  │
  ▼
hostContextMiddleware (NEW, global, before all routes)
  │  extractSlugCandidate(hostname) → "acme"
  │  reserved-word check → not reserved
  │  Master DB: Tenant.findOne({ tenantCode: "ACME" })   ← same natural
  │             key Phase F/G already use, no new column
  │  status check → ACTIVE
  │  Master DB: TenantDatabase.findOne({ tenantId })
  │  status check → READY
  │  req.hostContext = { type:"tenant", slug:"acme", tenantId:42, ... }
  ▼
[route's own middleware chain — unchanged]
  │
  ▼
authMiddleware → JWT verified → req.user = { id, role, tenantId, ... }
  ▼
tenantResolverMiddleware (EXTENDED)
  │  if req.hostContext.type === "tenant"
  │     and req.hostContext.tenantId !== req.user.tenantId
  │       → 403 (brief's JWT-security requirement)
  │  Master DB: Tenant.findByPk(tenantId)         ← unchanged, Phase E/G
  │  Master DB: TenantDatabase.findOne(...)        ← unchanged
  │  getTenantConnection(tenantId)                 ← unchanged cache
  │  req.models = <tenant 42's own connection's models>
  ▼
existing controllers/services (req.models, req.masterModels)
```

Two middlewares, two distinct jobs, exactly matching the brief's own
split: hostname → tenant **identity** (new), JWT → tenant **connection**,
now cross-checked against that identity (extended, not duplicated).

## 4. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BASE_DOMAIN` | unset | Tenant application base, e.g. `app.mydms.com`. **Unset = feature fully disabled**, every request resolves tenant from the JWT only (pre-Phase-H behavior, verified live). |
| `TRUST_PROXY_HOPS` | `0` | Number of trusted reverse-proxy hops (Nginx/Cloudflare/LB) in front of this process. `0` = Express trusts no `X-Forwarded-*` header at all (safe default for a directly-exposed process). Set to `1` for the common single-reverse-proxy case. |

Both documented inline in `.env.example` and `.env`.

## 5. Local testing

`BASE_DOMAIN=app.localhost` works with **zero extra setup** — `*.localhost`
resolves to `127.0.0.1` automatically in every modern OS resolver (RFC
6761), and `hostContextMiddleware.js`'s slug-extraction logic has no
special-casing for it; it's the same suffix-matching code path as
production. Two ways to exercise it locally without owning real DNS:

1. **Real browser/OS resolution** (works out of the box on macOS/Linux,
   most modern Windows): visit `http://acme.app.localhost:3000` directly.
2. **`curl -H "Host: ..."`** (used for every test below, no `/etc/hosts`
   edits needed): `curl -H "Host: acme.app.localhost" http://127.0.0.1:3000/...`

### Live test results (real MariaDB, real HTTP requests — not simulated)

Seeded: Tenant A `acme` (ACTIVE, `TenantDatabase` READY), Tenant B `tcs`
(INACTIVE), Tenant C `beta` (ACTIVE, READY), a SuperAdmin, and a
TenantAdmin user for `acme`.

| # | Request | Expected (brief) | Result |
|---|---|---|---|
| 1 | `Host: acme.app.localhost`, `GET /` | tenant resolves | ✅ `200` |
| 2 | `Host: unknown.app.localhost`, `GET /api/documents` | `404` | ✅ `404 {"message":"Unknown tenant"}` |
| 3 | `Host: tcs.app.localhost` (INACTIVE), `GET /api/documents` | `403` | ✅ `403 {"message":"Tenant is inactive"}` |
| 4 | `Host: admin.app.localhost` (reserved word), `GET /` | non-tenant passthrough | ✅ `200` (not forced through tenant resolution) |
| 5 | `Host: 127.0.0.1` (no subdomain), `GET /` (health) | works without tenant | ✅ `200` |
| 6 | `Host: 127.0.0.1`, `POST /api/subscriptions/register/send-otp` | works without tenant | ✅ `200 {"message":"OTP sent"}` |
| 7 | `Host: acme.app.localhost`, login as `acme`'s admin | tenant A | ✅ JWT issued, `tenantId:1` |
| 8 | `Host: acme.app.localhost` + tenant-A JWT, `GET /api/document-types` | allowed | ✅ `200` |
| 9 | **`Host: beta.app.localhost` (tenant C, ACTIVE+READY) + tenant-A JWT** | **`403`** | ✅ `403 {"message":"Forbidden: token does not belong to this tenant workspace"}` |
| 10 | Same tenant-A JWT back on `Host: acme.app.localhost` | still allowed | ✅ `200` (proves #9 wasn't a broken JWT — the *host* mismatch specifically is what's rejected) |
| 11 | Same tenant-A JWT on `Host: 127.0.0.1` (no subdomain) | still allowed | ✅ `200` (backward compat: JWT-only path unaffected when not using a tenant subdomain) |
| 12 | SuperAdmin login via `Host: acme.app.localhost` | works, Master DB | ✅ JWT issued (`role:"SuperAdmin"`, `tenantId:null`) |
| 13 | SuperAdmin JWT + `Host: acme.app.localhost`, `GET /api/subscriptions` | works, not forced through tenant resolution | ✅ `200` — no host/JWT cross-check applied (SuperAdmin bypasses tenant resolution entirely, brief's explicit instruction) |
| 14 | `BASE_DOMAIN` unset entirely, login + authenticated request via plain `http://127.0.0.1:3000` | identical to pre-Phase-H behavior | ✅ Both `200` — confirms the feature is a true no-op when not configured |

Test #9/#10 together are the critical proof: the same valid JWT is
accepted on its own tenant's subdomain and rejected on a different
(otherwise perfectly valid, ACTIVE, READY) tenant's subdomain — exactly
the brief's worked example (`tcs.../tenantId=42 JWT → 403`, generalized
here to an active tenant so the 403 is provably the *cross-check*, not
just "host itself was already invalid").

`isAllowedOrigin()` (CORS) unit-tested directly, 8/8 cases pass:
`http://localhost:5173` ✅, `https://acme.app.localhost` ✅,
`https://tcs.app.localhost` ✅, `https://evil.com` ❌ (correctly
rejected), `https://app.localhost` (bare BASE_DOMAIN, no tenant) ❌
(correctly rejected), `https://foo.acme.app.localhost` (two subdomain
levels) ❌ (correctly rejected), `http://acme.app.localhost:5173`
(port preserved) ✅, no `Origin` header at all (non-browser client) ✅.

## 6. Production testing (what still needs a real environment)

Not verifiable in this sandbox (no real DNS, no reverse proxy in front of
this process):

- **Wildcard DNS**: `*.app.mydms.com` must actually resolve — **not
  configured or claimed configured by this phase**, per the brief's
  explicit instruction. Point it at the load balancer/reverse proxy in
  front of this app.
- **TLS**: a wildcard certificate for `*.app.mydms.com` (or per-subdomain
  certs via ACME DNS-01) at the reverse proxy/load balancer — outside
  this backend's scope.
- **`TRUST_PROXY_HOPS`**: set to the actual number of reverse-proxy hops
  in the real deployment (verify with `req.hostname`/`req.ip` logging
  temporarily after deploying — see `structuredLog`'s `host` field) so
  `hostContextMiddleware.js` sees the real client-requested Host, not the
  proxy's own.
- **Real cross-subdomain cookie behavior**, if the frontend ever moves
  off `Authorization: Bearer` headers onto cookies — this backend
  currently only issues bearer tokens (unchanged this phase), which
  sidesteps cookie-domain concerns entirely; flagged here only because
  it's a common next question once wildcard subdomains are live.

## 7. Security verification

- **Hostname never used as an identity source for authenticated
  requests** — only as a *check* against the JWT's own `tenantId`. Test
  #9 above is the live proof.
- **`tenantId` never read from `req.params`/`req.body`/`req.query`
  anywhere in this phase's code** — confirmed by re-grepping both
  middleware files; the only two tenantId sources are the verified JWT
  payload (`req.user.tenantId`, unchanged from Phase E) and the Master-DB-
  resolved `req.hostContext.tenantId` (never client-supplied — it's a
  lookup result, not an echoed header).
- **Reserved subdomains** (`www`, `admin`, `api`, `app`, `mail`,
  `support`, `status`, `billing`, `docs`, `help`, `cdn`, `static`) can
  never resolve as a tenant, checked *before* any database query — even
  if a `Tenant.tenantCode` happened to collide with one of these words.
- **Slug shape validated before any query**: `SLUG_PATTERN` rejects
  anything that isn't a single, safe DNS label — the Host header is
  attacker-controlled input over raw HTTP and is treated as such, not
  trusted just because a browser normally wouldn't send something
  malformed.
- **No `Access-Control-Allow-Origin: *`** anywhere — `corsOptions.js`
  always echoes back a specific validated origin or omits the header;
  this is required regardless of preference, since `credentials: true` +
  `*` is rejected by every browser's fetch/XHR implementation.
- **Errors never expose database name, password, SQL, or a stack trace**:
  every denial in `hostContextMiddleware.js` returns a fixed, generic
  message (`"Unknown tenant"`, `"Tenant is {status}"`, etc.); the
  `try/catch`'s failure path logs the real error server-side only and
  returns `"Internal server error"`. `tenantResolverMiddleware.js`'s
  pre-existing raw-`error.message` leak (predating this phase) was fixed
  as part of this same file being touched — see "Files changed."
- **Logging** (`requestContextMiddleware.js`'s `structuredLog`) is a
  closed whitelist of fields (`requestId`, `event`, `host`, `tenantSlug`,
  `tenantId`, `route`, `status`) — it cannot accidentally leak a caller's
  extra object properties (a JWT, a password, `req.body`, a Sequelize
  model instance) because it never accepts or spreads an arbitrary
  object; every call site in this phase passes only these primitive
  fields explicitly.
- **`trust proxy` defaults to disabled (`0`)** — a directly-exposed
  process (misconfigured `TRUST_PROXY_HOPS`, or no reverse proxy at all
  yet) cannot have its `req.hostname`/`req.ip` spoofed by an arbitrary
  client-supplied `X-Forwarded-Host`/`X-Forwarded-For` header, per the
  brief's "Do not blindly trust arbitrary forwarded headers."

## Remaining risks / follow-ups

- **Tenant provisioning does not itself validate `tenantCode` against
  `RESERVED_SUBDOMAINS`** — the routing layer defensively refuses to
  treat a reserved word as a tenant slug regardless (see "Security
  verification" above), but a defense-in-depth improvement would be
  rejecting a reserved `tenantCode` at creation time too
  (`tenantProvisioningService.js` / the FREE-registration
  `generateTenantCode()` in `subscriptionController.js`). Not changed
  this phase — provisioning logic is explicitly out of scope per this
  and prior phases' briefs ("do not recreate tenant provisioning").
- **FREE self-registered tenants get an auto-generated, non-vanity
  `tenantCode`** (e.g. `FREE-123456-ABCDEF`, from the existing
  `generateTenantCode()`), which becomes their subdomain slug verbatim
  (lowercased: `free-123456-abcdef.app.mydms.com`). This is DNS-safe and
  functionally correct, just not a pretty URL — a future phase could add
  a real vanity-slug field to `Tenant` if desired; this phase reuses the
  existing `tenantCode` exactly as-is, per "do not redesign the database
  architecture."
- **`planController.js`** still imports the pre-existing
  `src/models/master.js` compatibility shim rather than the real
  `src/models/masterDb` (a Phase G finding, unrelated to subdomain
  routing, left as-is since touching it wasn't in this phase's scope).
- **Wildcard DNS/TLS/reverse-proxy configuration** — explicitly not done,
  per the brief's own instruction not to configure DNS or claim it's
  configured.

---

## STOP

Per the brief: backend implementation only. Not configuring DNS.
