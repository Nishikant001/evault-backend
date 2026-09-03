// src/database/legacyMigration/scopeSql.js
//
// PHASE F — turns a tenantTableRegistry `tenantScope` entry into a real
// Sequelize `where` fragment that selects exactly one tenant's rows,
// WITHOUT hardcoding any table or column name as a string. Table names
// are read from each legacy model's own `getTableName()` and the
// tenantId column is always the literal `tenantId` (verified against
// every model in the audit — see PHASE_F migration report section 1).
//
// Rationale for building this generically instead of hand-writing a
// query per table: several tenant tables (ApprovalAssignment, OcrAlias,
// ...) only reach a tenantId column through 2-3 FK hops. Hand-writing
// that JOIN chain 34 times is exactly the kind of mechanical, error-prone
// work a shared builder removes — and because every hop resolves table
// names from the actual model objects, a future column rename in a model
// file cannot silently desync this tool from the schema.
const { Sequelize } = require("sequelize");

/**
 * Build a Sequelize `where` object that scopes `legacyModels[entry.model]`
 * rows down to a single tenant, using literal correlated subqueries for
 * indirect (`via`) chains.
 *
 * @param {object} legacyModels - the legacy `require("../../models")` export
 * @param {object} entry - one entry from tenantTableRegistry
 * @param {number} tenantId
 * @returns {object} Sequelize `where` clause
 */
function buildTenantScopeWhere(legacyModels, entry, tenantId) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`buildTenantScopeWhere: invalid tenantId ${tenantId}`);
  }

  if (entry.tenantScope.direct) {
    return { tenantId: id };
  }

  const sql = buildViaSubqueryChain(legacyModels, entry.tenantScope.via, id);
  return { [Sequelize.Op.and]: [Sequelize.literal(sql)] };
}

/**
 * Same scoping logic, but returns a raw SQL WHERE fragment (no leading
 * "WHERE") for use in raw COUNT/verification queries against the legacy
 * connection directly, e.g. for the dry-run row-count report where
 * pulling every column via a full model findAll would be wasteful.
 */
function buildViaSubqueryChain(legacyModels, chain, tenantId) {
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error("buildViaSubqueryChain: chain must be a non-empty array for indirect tenantScope");
  }

  // Walk the chain from the innermost (closest to the table with direct
  // tenantId) outward isn't necessary — we build it recursively from the
  // first hop, nesting each subsequent hop's condition inside.
  function build(index) {
    const hop = chain[index];
    const hopModel = legacyModels[hop.model];
    if (!hopModel) {
      throw new Error(`buildViaSubqueryChain: unknown model "${hop.model}" referenced in scope chain`);
    }
    const table = hopModel.getTableName();
    const isLast = index === chain.length - 1;
    const innerCondition = isLast ? `tenantId = ${tenantId}` : build(index + 1);
    return `${quoteIdent(hop.column)} IN (SELECT \`id\` FROM \`${table}\` WHERE ${innerCondition})`;
  }

  return build(0);
}

function quoteIdent(col) {
  // Defence in depth: column names come only from our own registry file,
  // never from user input, but this still guards against a typo that
  // would otherwise silently build invalid/unsafe SQL.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) {
    throw new Error(`quoteIdent: refusing unsafe column identifier "${col}"`);
  }
  return `\`${col}\``;
}

module.exports = { buildTenantScopeWhere, buildViaSubqueryChain };
