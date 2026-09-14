// src/utils/deviceParser.js
//
// Small, dependency-free User-Agent parser.
// Used ONLY by the Audit Trail system to capture Browser / OS / Device
// information for each audit entry. Kept intentionally lightweight
// (no new npm package) so it never affects existing functionality.

/**
 * Parse a raw User-Agent header string into browser / OS / device info.
 * Falls back to "Unknown" for anything it cannot confidently detect —
 * this function must NEVER throw, since audit logging must never break
 * the calling request.
 *
 * @param {string} userAgent - raw value of req.headers['user-agent']
 * @returns {{ browser: string, operatingSystem: string, device: string }}
 */
function parseUserAgent(userAgent) {
  try {
    const ua = (userAgent || "").toString();

    if (!ua) {
      return {
        browser: "Unknown",
        operatingSystem: "Unknown",
        device: "Unknown",
      };
    }

    // ── Browser detection (order matters — e.g. Edge/Opera also contain "Chrome") ──
    let browser = "Unknown";
    if (/edg\//i.test(ua)) browser = "Edge";
    else if (/opr\/|opera/i.test(ua)) browser = "Opera";
    else if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) browser = "Chrome";
    else if (/chromium\//i.test(ua)) browser = "Chromium";
    else if (/firefox\//i.test(ua)) browser = "Firefox";
    else if (/safari\//i.test(ua) && /version\//i.test(ua)) browser = "Safari";
    else if (/msie |trident\//i.test(ua)) browser = "Internet Explorer";
    else if (/postman/i.test(ua)) browser = "Postman";
    else if (/curl\//i.test(ua)) browser = "cURL";
    else if (/axios\//i.test(ua)) browser = "Axios (API Client)";

    // ── Operating system detection ──────────────────────────────
    let operatingSystem = "Unknown";
    if (/windows nt 10/i.test(ua)) operatingSystem = "Windows 10/11";
    else if (/windows nt/i.test(ua)) operatingSystem = "Windows";
    else if (/mac os x/i.test(ua)) operatingSystem = "macOS";
    else if (/android/i.test(ua)) operatingSystem = "Android";
    else if (/iphone|ipad|ipod/i.test(ua)) operatingSystem = "iOS";
    else if (/linux/i.test(ua)) operatingSystem = "Linux";

    // ── Device type detection ───────────────────────────────────
    let device = "Desktop";
    if (/mobile/i.test(ua) && !/ipad/i.test(ua)) device = "Mobile";
    else if (/ipad|tablet/i.test(ua)) device = "Tablet";
    else if (/postman|curl\/|axios\//i.test(ua)) device = "API Client";

    return { browser, operatingSystem, device };
  } catch (error) {
    // Never let a parsing error break audit logging.
    return {
      browser: "Unknown",
      operatingSystem: "Unknown",
      device: "Unknown",
    };
  }
}

/**
 * Resolve the real client IP address, accounting for reverse proxies /
 * load balancers that set X-Forwarded-For.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function resolveIpAddress(req) {
  try {
    const forwarded = req.headers?.["x-forwarded-for"];
    if (forwarded) {
      // X-Forwarded-For can contain a comma separated list; the first
      // entry is the original client.
      return forwarded.split(",")[0].trim();
    }
    return req.ip || req.connection?.remoteAddress || "Unknown";
  } catch (error) {
    return "Unknown";
  }
}

module.exports = {
  parseUserAgent,
  resolveIpAddress,
};
