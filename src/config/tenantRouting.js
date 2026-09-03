// src/config/tenantRouting.js
//
// PHASE H — WILDCARD SUBDOMAIN TENANT ROUTING. Shared config + pure
// helper functions used by hostContextMiddleware.js. Kept separate from
// the middleware so the parsing/validation logic is independently
// testable and has a single source of truth for BASE_DOMAIN / reserved
// words, rather than being duplicated across middleware and CORS config.
//
// ── Domain shape (brief) ────────────────────────────────────────────
//   Main domain:              mydms.com
//   Tenant application base:  app.mydms.com          (BASE_DOMAIN)
//   Tenant URL:                https://acme.app.mydms.com
//
// BASE_DOMAIN is the tenant APPLICATION base — NOT the bare apex domain.
// A request's hostname must be exactly `<slug>.<BASE_DOMAIN>` to be
// treated as a tenant request. Anything else (the apex domain, an
// `admin.` subdomain, an `api.` subdomain, or BASE_DOMAIN with no
// subdomain at all) is explicitly a NON-tenant request and is never
// forced through tenant resolution — see hostContextMiddleware.js.
const BASE_DOMAIN = (process.env.BASE_DOMAIN || "").toLowerCase().trim();

// Subdomains that must NEVER be treated as a tenant slug, even if a
// Tenant row with a matching tenantCode somehow existed (defense in
// depth — tenant provisioning should also refuse to assign one of these
// as a tenantCode; see PHASE_H report "Remaining risks").
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "admin",
  "api",
  "app",
  "mail",
  "support",
  "status",
  "billing",
  "docs",
  "help",
  "cdn",
  "static",
]);

// A DNS label: lowercase alphanumeric, internal hyphens only, 1-63
// chars, never starting/ending with a hyphen. Applied to the raw
// hostname segment BEFORE it is ever used in a database query — this is
// untrusted, attacker-controlled input (the Host header), so it is
// validated as a safe identifier shape first regardless of what a
// parameterized query would already protect against.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Extracts a candidate tenant slug from a request hostname, or null if
 * the hostname isn't in the `<slug>.<BASE_DOMAIN>` shape at all (bare
 * BASE_DOMAIN, the apex domain, an unrelated host, etc.) — null means
 * "this is not a tenant-subdomain request," not "invalid slug."
 *
 * Local development note: BASE_DOMAIN can be set to `app.localhost` (see
 * PHASE_H report "Local testing") and this function works identically —
 * `acme.app.localhost` extracts `acme` the same way
 * `acme.app.mydms.com` does. No special-casing needed.
 */
function extractSlugCandidate(hostname) {
  if (!BASE_DOMAIN || !hostname) return null;
  const host = hostname.toLowerCase().trim();

  // Exactly BASE_DOMAIN itself (no subdomain) -> not a tenant request.
  if (host === BASE_DOMAIN) return null;

  const suffix = `.${BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;

  const candidate = host.slice(0, -suffix.length);
  // Reject multi-level subdomains (e.g. "foo.acme.app.mydms.com") — a
  // tenant slug is always exactly one label directly under BASE_DOMAIN.
  if (candidate === "" || candidate.includes(".")) return null;

  return candidate;
}

/** True if `slug` is a syntactically valid, non-reserved DNS label. */
function isAssignableSlug(slug) {
  return typeof slug === "string" && SLUG_PATTERN.test(slug) && !RESERVED_SUBDOMAINS.has(slug);
}

module.exports = {
  BASE_DOMAIN,
  RESERVED_SUBDOMAINS,
  SLUG_PATTERN,
  extractSlugCandidate,
  isAssignableSlug,
};
