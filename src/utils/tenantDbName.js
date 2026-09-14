// src/utils/tenantDbName.js
//
// PHASE D — safe, deterministic tenant database naming.
//
// The database name is ALWAYS derived from the tenant's own numeric
// primary key (tenantId), never from client-supplied input (company
// name, tenant code, etc.). This is the whole security property the
// brief asks for: a client can influence what a tenant is CALLED
// (tenantName/tenantCode), but never what physical database backs it.
const DB_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Deterministically derive the physical database name for a tenant.
 * Same tenantId -> same name, every time -> naturally idempotent and
 * safe to call repeatedly during retries.
 *
 * @param {number} tenantId
 * @returns {string} e.g. "tenant_42"
 */
function generateTenantDatabaseName(tenantId) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`generateTenantDatabaseName: tenantId must be a positive integer, got ${tenantId}`);
  }
  const prefix = sanitizePrefix(process.env.TENANT_DB_PREFIX || "tenant");
  const name = `${prefix}_${id}`;
  assertSafeDatabaseName(name);
  return name;
}

function sanitizePrefix(prefix) {
  const cleaned = String(prefix).toLowerCase().replace(/[^a-z0-9_]/g, "");
  return cleaned || "tenant";
}

/**
 * Defence in depth: even though callers never pass client input here,
 * any database name that is about to be interpolated into a raw
 * `CREATE DATABASE` / `DROP DATABASE` identifier is validated against
 * a strict allow-list pattern first. Throws rather than silently
 * stripping characters, so a bad name fails loudly instead of quietly
 * connecting to the wrong (or an attacker-influenced) database.
 *
 * @param {string} name
 */
function assertSafeDatabaseName(name) {
  if (typeof name !== "string" || !DB_NAME_PATTERN.test(name)) {
    throw new Error(
      `Refusing unsafe database identifier "${name}" — must match ${DB_NAME_PATTERN} ` +
        `(lowercase letters, digits, underscores, starting with a letter, max 63 chars).`,
    );
  }
}

module.exports = { generateTenantDatabaseName, assertSafeDatabaseName };
