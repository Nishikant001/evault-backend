// src/config/corsOptions.js
//
// PHASE H — dynamic CORS origin validation for wildcard tenant
// subdomains. `Access-Control-Allow-Origin: *` is not usable once
// `credentials: true` is set (the fetch/XHR spec forbids it — browsers
// reject the response outright), so a wildcard subdomain frontend
// requires validating the ORIGIN dynamically and echoing back that exact
// origin when it's allowed, never a literal "*".
//
// Allowed:
//   - https://<any-label>.<BASE_DOMAIN>   (e.g. https://acme.app.mydms.com)
//   - the existing local dev origins (preserved exactly as before this
//     phase — see ALLOWED_STATIC_ORIGINS)
//   - http://<any-label>.<BASE_DOMAIN_LOCAL>  when BASE_DOMAIN itself is
//     a *.localhost value in development (see tenantRouting.js's local
//     dev note) — covered automatically by the same suffix check, no
//     special-casing needed.
//
// Anything else is rejected (the `cors` package then omits the
// Allow-Origin header entirely, which the browser treats as a CORS
// failure — never reflects an arbitrary Origin back).
const { BASE_DOMAIN } = require("./tenantRouting");

// PRODUCTION DEPLOYMENT — local dev convenience origins. Only included
// when NOT running in production, so a production deployment never
// silently trusts http://localhost:* as an allowed CORS origin.
const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
];

// PRODUCTION DEPLOYMENT — additional exact origins (the marketing site,
// a separate admin dashboard, a mobile-web shell, etc.) that are NOT
// themselves a "<slug>.<BASE_DOMAIN>" tenant subdomain, configured via
// env instead of hard-coded so ops can add/remove one without a code
// change or redeploy of application logic. Comma-separated, exact
// origins including scheme, e.g.:
//   EXTRA_ALLOWED_ORIGINS=https://mydms.com,https://admin.mydms.com
const EXTRA_ALLOWED_ORIGINS = (process.env.EXTRA_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const ALLOWED_STATIC_ORIGINS = [
  ...(process.env.NODE_ENV === "production" ? [] : DEV_ORIGINS),
  ...EXTRA_ALLOWED_ORIGINS,
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser clients (curl, server-to-server, mobile) send no Origin header at all
  if (ALLOWED_STATIC_ORIGINS.includes(origin)) return true;

  if (!BASE_DOMAIN) return false;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  // Must be exactly "<label>.<BASE_DOMAIN>" — one subdomain level under
  // BASE_DOMAIN, same shape hostContextMiddleware.js enforces for the
  // Host header, applied here to the Origin header instead. Scheme is
  // intentionally not restricted to https here: BASE_DOMAIN=app.localhost
  // in local development is legitimately http://.
  const host = url.hostname.toLowerCase();
  if (host === BASE_DOMAIN) return false; // bare BASE_DOMAIN itself is never a tenant frontend origin
  const suffix = `.${BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, -suffix.length);
  return label !== "" && !label.includes(".");
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(null, false); // reject silently — `cors` then omits the header rather than throwing a 500
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

module.exports = { corsOptions, isAllowedOrigin };
