# Production Deployment Guide — Wildcard Multi-Tenant Deployment

This document covers taking the existing Phase A–H backend (Master DB +
tenant DBs + connection pooling + wildcard subdomain resolution + JWT
tenant isolation) to production under a real domain.

Every section is split into:
- **🤖 AUTOMATED (in this repo)** — code/config committed to the
  repository. Verified by reading the actual source, listed below.
- **🧑‍🔧 MANUAL (you must do this on your infra)** — DNS panel, SSL
  issuance, server provisioning, Nginx install. **Nothing in this repo
  can perform these steps for you.** They are not "done" until you do
  them and they are verified against your real domain.

Replace `YOUR_DOMAIN` (e.g. `mydms.com`) and `YOUR_PORT` (your `.env`
`PORT`, default `3000`) everywhere below.

---

## 1. DNS

**🧑‍🔧 MANUAL — your DNS provider's dashboard, not this repo.**

The provider is not assumed. Two DNS records are needed:

| Record | Host | Value | Notes |
|---|---|---|---|
| A or CNAME | `app` | `YOUR_SERVER_IP` (A) or your load balancer's hostname (CNAME) | Bare `app.YOUR_DOMAIN` — the API/apex-of-tenants host |
| A or CNAME | `*.app` | same as above | The **wildcard** — every `<tenant>.app.YOUR_DOMAIN` |

- If you have a single server with a static IP → use **A records**
  pointing `app` and `*.app` at that IP.
- If you're behind a load balancer / CDN (AWS ALB, Cloudflare, etc.) →
  use **CNAME records** pointing `app` and `*.app` at the LB's DNS
  name. Most providers do not allow a CNAME at the apex (`YOUR_DOMAIN`
  itself) — only subdomains, which `app` and `*.app` both are, so this
  is fine.
- Some DNS UIs let you enter a single wildcard row `*.app` — others
  require you to also keep the non-wildcard `app` row explicitly (a
  wildcard does **not** always also match the exact `app.YOUR_DOMAIN`
  hostname, depending on provider). Add both rows to be safe.
- **Verify before continuing** — do not proceed to SSL until this
  resolves:
  ```bash
  dig +short app.YOUR_DOMAIN
  dig +short acme.app.YOUR_DOMAIN     # any label — wildcard should match
  dig +short random-label-12345.app.YOUR_DOMAIN
  ```
  All three should return the same IP (or LB CNAME chain). If any
  returns nothing, DNS has not propagated or the record is wrong —
  stop here, this is not an application-code problem.

---

## 2. SSL — wildcard certificate for `*.app.YOUR_DOMAIN`

**🧑‍🔧 MANUAL — certificate issuance and renewal setup on the server.**

A wildcard cert **requires DNS-01 validation** (not HTTP-01) — the CA
needs proof you control the DNS zone, since there's no single file path
to serve for every possible subdomain.

### Option A — Let's Encrypt (certbot), self-managed Nginx termination
```bash
# MANUAL, run once on the server, requires your DNS provider's API
# token if using an automated DNS plugin (e.g. certbot-dns-cloudflare):
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d "app.YOUR_DOMAIN" -d "*.app.YOUR_DOMAIN"

# No DNS API plugin available: certbot will print a TXT record to
# create manually, wait for you to confirm it's live, then issue.
sudo certbot certonly --manual --preferred-challenges dns \
  -d "app.YOUR_DOMAIN" -d "*.app.YOUR_DOMAIN"
```
This issues `/etc/letsencrypt/live/app.YOUR_DOMAIN/{fullchain.pem,privkey.pem}`,
which `deploy/nginx.conf.example` already points at.

**Renewal:** Let's Encrypt certs expire every 90 days. `certbot` installs
a systemd timer / cron job automatically (`sudo systemctl status
certbot.timer` to confirm). If you used the DNS-01 **manual** flow, the
manual hook does **not** auto-renew — switch to a DNS plugin, or your
own renewal script, before the cert expires.

### Option B — Cloudflare (proxy mode) terminates TLS for you
If your DNS is on Cloudflare with the orange-cloud proxy enabled,
Cloudflare issues and manages the edge certificate for you (Cloudflare
dashboard → SSL/TLS → Edge Certificates → "Universal SSL" already
covers one level of wildcard; enable **Total TLS** for `*.app.YOUR_DOMAIN`
specifically). In this setup:
- Set SSL/TLS mode to **Full (strict)** — Cloudflare ↔ origin still
  needs a valid cert on your Nginx (use Option A for that origin cert,
  or a Cloudflare Origin CA certificate instead, which is free and
  simpler for origin-only use).
- `deploy/nginx.conf.example` still applies for the origin server.

### Option C — Load balancer / ALB termination
If a cloud load balancer terminates TLS (e.g. AWS ACM + ALB), request
the wildcard cert in ACM (`*.app.YOUR_DOMAIN` + `app.YOUR_DOMAIN`), which
ACM validates via DNS-01 (create the CNAME it gives you) and
auto-renews. Nginx then only needs to listen on plain HTTP behind the
LB — `X-Forwarded-Proto` from the LB tells Node the original scheme
(already handled by `TRUST_PROXY_HOPS`, see §4).

**Never commit `.pem`/`.key` files to Git** — `.gitignore` in this repo
already excludes `*.pem`, `*.key`, `*.crt` (🤖 AUTOMATED, verify with
`git check-ignore -v /etc/letsencrypt/live/app.YOUR_DOMAIN/privkey.pem`
if you ever copy certs into the repo directory, which you shouldn't).

---

## 3. Nginx

**🤖 AUTOMATED (config file provided)** — `deploy/nginx.conf.example`
**🧑‍🔧 MANUAL (installing it)** — copying it into `/etc/nginx/` and
reloading is a server action this repo cannot perform.

The provided config (`deploy/nginx.conf.example`):
- `server_name *.app.YOUR_DOMAIN` for the tenant wildcard block, plus a
  separate block for the bare `YOUR_DOMAIN` / `app.YOUR_DOMAIN` API host.
- `proxy_pass http://127.0.0.1:YOUR_PORT` — no server IP hard-coded
  anywhere; Nginx always talks to the app over loopback.
- Preserves `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`,
  `X-Forwarded-Host` — required because `hostContextMiddleware.js`
  resolves the tenant from `req.hostname`, which only reflects the real
  client Host header once Express is told to trust the proxy (§4).
- HTTP → HTTPS redirect on port 80 for all three host patterns.
- `client_max_body_size 60M` (headroom above the app's own 50 MB
  multer limit in `src/routes/documentRoutes.js` — confirmed by
  reading that file).
- Explicit `proxy_connect_timeout` / `proxy_read_timeout` /
  `proxy_send_timeout` / `send_timeout`.
- An Nginx-level `limit_req_zone` (defense in depth alongside the app's
  own `express-rate-limit`, already present in `src/app.js`).

Install:
```bash
# MANUAL, on the server:
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/procur.conf
sudo sed -i 's/YOUR_DOMAIN/mydms.com/g; s/YOUR_PORT/3000/g' \
  /etc/nginx/sites-available/procur.conf
sudo ln -s /etc/nginx/sites-available/procur.conf /etc/nginx/sites-enabled/
sudo nginx -t          # validate syntax BEFORE reloading
sudo systemctl reload nginx
```

---

## 4. Node (`trust proxy`)

**🤖 AUTOMATED — already implemented in `src/app.js`, not new code.**

```js
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
}
```

This is already correct for the documented topology (one Nginx hop in
front of Node): set `TRUST_PROXY_HOPS=1` in `.env` (now defaulted in
`.env.example`). It trusts **exactly one hop** of `X-Forwarded-*`
headers — not `app.set("trust proxy", true)`, which would trust an
unbounded chain and let a client forge its own `X-Forwarded-For`/`Host`
straight through. If you add a CDN or load balancer in front of Nginx,
increase to `TRUST_PROXY_HOPS=2` and confirm each hop actually
overwrites (not appends to) the forwarded headers.

**🧑‍🔧 MANUAL verification** (cannot be verified without your real
proxy in place): after deploying, confirm `req.hostname` inside the app
reflects the real client Host, not `127.0.0.1` — the `/health` and
`/health/tenant` responses (§7) implicitly prove this, since
`/health/tenant` can only resolve a tenant if `req.hostname` is correct.

---

## 5. CORS

**🤖 AUTOMATED — `src/config/corsOptions.js`.**

Already implemented, and extended in this deployment pass:
- Any `https://<slug>.app.YOUR_DOMAIN` is dynamically allowed by
  suffix-matching against `BASE_DOMAIN` (never a literal `*`, which is
  disallowed by the fetch/CORS spec whenever `credentials: true` is
  set, as this API does for JWT/cookie auth).
- `http://localhost:*` dev origins are now **excluded automatically
  when `NODE_ENV=production`** (previously always present).
- Non-tenant origins (marketing site, separate admin dashboard) are
  configured via **`EXTRA_ALLOWED_ORIGINS`** in `.env`, not hard-coded —
  see `.env.example`.
- Every other origin is rejected (the `cors` package omits the
  `Access-Control-Allow-Origin` header rather than reflecting an
  arbitrary origin back).

**🧑‍🔧 MANUAL** — set the real value in your production `.env`:
```
BASE_DOMAIN=app.mydms.com
EXTRA_ALLOWED_ORIGINS=https://mydms.com,https://admin.mydms.com
```

---

## 6. Security

**🤖 AUTOMATED — verified against actual source, and hardened this pass:**

| Control | Status | Where |
|---|---|---|
| Host header validation | ✅ Pre-existing | `hostContextMiddleware.js` — validates DNS-label shape before any DB query, rejects unknown/inactive/not-ready tenants with generic 404/403/503 |
| Tenant isolation (JWT ↔ host cross-check) | ✅ Pre-existing | `tenantResolverMiddleware.js` cross-checks JWT `tenantId` against `req.hostContext` — a valid JWT for tenant 42 cannot be replayed against tenant 43's subdomain |
| Rate limiting | ✅ Pre-existing (app-level) + ✅ new (Nginx-level) | `express-rate-limit` in `src/app.js`; `limit_req_zone` in `deploy/nginx.conf.example` |
| Helmet | ✅ Pre-existing | `app.use(helmet())` in `src/app.js` |
| CORS | ✅ Pre-existing, hardened this pass | §5 above |
| TLS | 🧑‍🔧 Manual (§2) | Nginx/LB terminates; app itself is plain HTTP behind the proxy, which is correct |
| Secure cookies | ⚠️ Verify before go-live | `cookie-parser` is mounted; if any route sets an auth cookie (vs. only `Authorization: Bearer`), confirm `secure: true, httpOnly: true, sameSite: "lax"/"strict"` is set on it — not verified here since no cookie-setting call site was found in the reviewed routes, so this is a **flag, not a fix** |
| HTTP security headers | ✅ Pre-existing (Helmet) + ✅ new (HSTS) | Helmet defaults + `Strict-Transport-Security` header added in `deploy/nginx.conf.example` |
| No leaked DB credentials / stack traces / internal DB names | ⚠️ Was a gap, fixed this pass | See below |
| `.env` never committed | ⚠️ Was a gap (no `.gitignore` existed), fixed this pass | New `.gitignore`; local `.env` was removed from the delivered bundle |

**The stack-trace/error-leak gap and its fix:** the app previously had
**no global error-handling middleware**. Any uncaught error (a thrown
exception, a rejected promise reaching Express, a raw driver error)
would fall through to Express 5's own default handler, which renders a
stack trace to the client outside of `NODE_ENV=production`, and can
still leak the raw driver `message` (which often embeds table/column
names or SQL fragments) even in production. Added:
- `src/middleware/errorHandlerMiddleware.js` — mounted last, after
  every route, in `src/app.js`. Logs the full error server-side only,
  returns a fixed generic JSON body to the client.
- `src/middleware/errorHandlerMiddleware.js`'s `notFoundHandler` for
  unmatched routes (previously unmatched routes fell through to
  Express's default 404 HTML page).

**🧑‍🔧 MANUAL — cannot be verified by reading code, must be checked
against the real deployment:**
- Firewall: only 80/443 (and SSH on a non-default port, ideally
  key-only) open to the internet; MySQL (3306) should **not** be
  internet-reachable — bind it to localhost or a private VPC subnet.
- OS-level patching / `unattended-upgrades` on the server.
- Database user for `MASTER_DB_USER`/`TENANT_DB_USER` should have only
  the privileges it needs (not a MySQL root/admin account).

---

## 7. Production environment (`.env`)

**🤖 AUTOMATED — `.env.example` in this repo, updated this pass with:**
`NODE_ENV`, `TRUST_PROXY_HOPS` (now documented as required, not
optional), `EXTRA_ALLOWED_ORIGINS`. All pre-existing vars (`BASE_DOMAIN`,
`MASTER_DB_*`, `TENANT_DB_*`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
`SUPER_ADMIN_*`, AI provider keys, vector store config) were already
present and are preserved as-is.

**🧑‍🔧 MANUAL — on the server, never in Git:**
```bash
cp .env.example .env
# then edit .env with real values:
#   NODE_ENV=production
#   BASE_DOMAIN=app.mydms.com
#   MASTER_DB_HOST=<real host>          MASTER_DB_PASSWORD=<real secret>
#   TENANT_DB_HOST=<real host>          TENANT_DB_PASSWORD=<real secret>
#   JWT_SECRET=<32+ random bytes>       JWT_REFRESH_SECRET=<different 32+ random bytes>
#   SUPER_ADMIN_EMAIL=<real email>      SUPER_ADMIN_PASSWORD=<real strong password>
#   TRUST_PROXY_HOPS=1
chmod 600 .env
```
Generate strong secrets, don't hand-type them:
```bash
openssl rand -base64 48   # run twice — once for JWT_SECRET, once for JWT_REFRESH_SECRET
```

---

## 8. Health check

**🤖 AUTOMATED — new this pass** (previously the only "health" endpoint
was `GET /` returning a plain text banner, with no DB check at all):

- `GET /health` — Node liveness + **Master DB** `authenticate()` check.
  Returns `200 {"status":"ok",...}` or `503 {"status":"error",...}`.
  Public, unauthenticated, mounted before every business route — this
  is what Nginx/LB/orchestrator should poll (`deploy/nginx.conf.example`
  already proxies `/health` explicitly).
- `GET /health/tenant` — separate endpoint that checks the **current
  tenant's** database, using the tenant resolved by
  `hostContextMiddleware` from the request's Host header. Returns `400`
  if hit on a non-tenant host (nothing to check), `200`/`503` otherwise.
  This deliberately does **not** run on every `/health` call — checking
  a tenant DB on every LB health probe would mean LB health depends on
  an arbitrary tenant's DB being up, which is wrong; call it explicitly
  per-tenant when you need it.

Both are implemented in `src/controllers/healthController.js` /
`src/routes/healthRoutes.js`, syntax-checked (`node --check`), not yet
verified against a live database — see §10 for the manual verification
command.

---

## 9. Deployment commands

**🤖 AUTOMATED steps, run in this order:**
```bash
# 1. Install dependencies
npm ci --omit=dev

# 2. Run Master DB migrations (schema, not sequelize.sync — see
#    app.js's own comment on why sync is never used in production)
npm run migrate:master

# 3. Start under PM2 (see deploy/ecosystem.config.js for why single
#    instance / fork mode, not cluster)
npm install -g pm2          # once per server
pm2 start deploy/ecosystem.config.js --env production
pm2 save                     # persist the process list
pm2 startup                  # MANUAL: run the sudo command this prints, once, to survive reboots
```

**🧑‍🔧 MANUAL, one-time server setup (before the above):**
- Provision the server, install Node.js (match the version in
  `package.json`'s engines if pinned — none is currently pinned, use
  the latest Node 20/22 LTS), MySQL, Nginx.
- Complete §1 (DNS), §2 (SSL), §3 (install Nginx config), §7 (`.env`).
- Create the Master DB and the MySQL user referenced by
  `MASTER_DB_USER`/`TENANT_DB_USER` in `.env`, with least-privilege
  grants (not root).

---

## 10. Testing commands

**🤖 AUTOMATED script provided** — `deploy/smoke-test.sh`:
```bash
BASE_DOMAIN=app.mydms.com ./deploy/smoke-test.sh acme tcs
```
Checks (against your **real, live** domain — this cannot be run until
DNS + SSL + Nginx + the app are all actually deployed):
- `https://app.YOUR_DOMAIN/health` → `200`, Master DB reachable
- `https://acme.app.YOUR_DOMAIN/health/tenant` and
  `https://tcs.app.YOUR_DOMAIN/health/tenant` → `200`, each tenant's own
  DB reachable
- `https://unknown-<random>.app.YOUR_DOMAIN/api/documents` → `404`
  (proves unknown subdomains are rejected, not silently served)
- TLS certificate on a tenant subdomain actually covers the wildcard
- `http://` requests redirect to `https://`

**🧑‍🔧 MANUAL — authenticated business-flow checks this script does
NOT cover** (needs real seeded tenant users/tokens, so cannot be
scripted generically here):
- [ ] `https://acme.app.YOUR_DOMAIN` and `https://tcs.app.YOUR_DOMAIN` each
      load and serve **only their own** tenant's data
- [ ] `https://unknown.app.YOUR_DOMAIN` → confirmed rejected (covered by
      smoke test above, re-verify manually once too)
- [ ] Cross-tenant JWT: log in as a tenant-42 user, take that JWT, call
      an authenticated endpoint on `tenant-43.app.YOUR_DOMAIN` → must be
      rejected (this exercises `tenantResolverMiddleware.js`'s
      JWT-vs-host cross-check under real conditions, not just by
      reading the code)
- [ ] SuperAdmin login (bare `app.YOUR_DOMAIN`, not a tenant subdomain)
- [ ] Registration (new tenant signup flow)
- [ ] Login (existing tenant user)
- [ ] Documents: list/view
- [ ] Upload (confirm a file near-but-under 50 MB succeeds, and Nginx's
      60 MB `client_max_body_size` doesn't clip it early)
- [ ] Approval workflow: submit → approve/reject
- [ ] Subscription: plan enforcement (FREE plan limits actually enforced)
- [ ] Trial: trial-expiry scheduler behavior (`subscriptionScheduler`)
- [ ] Notifications: in-app notification delivery

**This checklist is not "passed" until each box is manually exercised
against the live deployment — nothing above claims these already work
in production, only that the code paths exist and were reviewed.**

---

## 11. Rollback procedure

**🤖 AUTOMATED tooling used, 🧑‍🔧 MANUAL decision to trigger it:**

```bash
# 1. Stop taking new traffic to the bad version, keep old one warm if possible
pm2 stop procur-backend

# 2. Roll back application code to the last known-good commit/tag
git fetch --tags
git checkout <last-good-tag-or-commit>
npm ci --omit=dev

# 3. Roll back the Master DB migration IF the bad deploy included one
#    (skip this if the rollback is code-only — undoing a migration on a
#    live DB is itself risky; confirm the down-migration is safe first)
npm run migrate:master:status         # see what's applied
npm run migrate:master:undo           # undoes the LAST migration only

# 4. Restart
pm2 restart procur-backend

# 5. Re-run the smoke test before declaring rollback complete
BASE_DOMAIN=app.mydms.com ./deploy/smoke-test.sh acme tcs
```

**🧑‍🔧 MANUAL, before any of the above:**
- Database rollback for **tenant** databases is separate per-tenant
  schema versioning (`src/database/tenant/migrationRunner.js`, per
  Phase G/H reports) — decide per-incident whether a tenant-DB rollback
  is even needed; most rollbacks are code-only.
- Nginx config rollback, if the bad deploy touched
  `deploy/nginx.conf.example`: `sudo nginx -t` against the previous
  version before reloading — never reload an unvalidated config.
- Keep the previous PM2-managed process/version identifiable
  (`pm2 list`, tag releases in Git) so "last known good" is unambiguous
  under incident pressure.

---

## 12. Security checklist (go/no-go before DNS cutover)

- [ ] `.env` on the server has real, unique secrets — not the
      `CHANGE_ME` placeholders from `.env.example`
- [ ] `.env` is `chmod 600`, owned by the app user, not world-readable
- [ ] `.gitignore` present and `.env` confirmed untracked:
      `git check-ignore -v .env`
- [ ] `NODE_ENV=production` set (disables dev CORS origins)
- [ ] `TRUST_PROXY_HOPS` matches the **actual** number of reverse
      proxies in front of Node (1 for the documented single-Nginx
      topology) — never `true`/unbounded
- [ ] DNS wildcard resolves correctly (§1 `dig` checks)
- [ ] Wildcard TLS certificate installed and covers `*.app.YOUR_DOMAIN`,
      not just `app.YOUR_DOMAIN`
- [ ] HTTP → HTTPS redirect confirmed (`deploy/smoke-test.sh`)
- [ ] `GET /health` returns `200` against the real Master DB
- [ ] Unknown-tenant subdomain confirmed to return 404, not fall
      through to any tenant's data
- [ ] MySQL not reachable from the public internet (firewall/security
      group check)
- [ ] `EXTRA_ALLOWED_ORIGINS` contains only real, intended origins — no
      leftover dev/test entries
- [ ] Full authenticated test checklist in §10 executed at least once
      against the live environment
