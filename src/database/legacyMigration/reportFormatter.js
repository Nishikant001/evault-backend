// src/database/legacyMigration/reportFormatter.js
//
// PHASE F — pretty-printers matching the exact report shape brief STEP 3
// asks for ("Tenant / Source rows / Destination / Expected rows /
// Missing / Conflicts"), plus formatters for the skipped-tenant list,
// the post-migration summary, and the verification report.
function formatSkippedTenants(skipped) {
  if (skipped.length === 0) return "";
  const lines = ["", "Skipped tenants (not eligible — see reason):", ""];
  for (const s of skipped) {
    lines.push(`  Legacy Tenant: ${s.tenantName} (legacy id ${s.legacyTenantId}, code ${s.tenantCode})`);
    lines.push(`    Reason: ${s.reason}`);
  }
  return lines.join("\n");
}

function formatDryRunReport(report) {
  const lines = [];
  lines.push("");
  lines.push(`Tenant: ${report.tenantName} (${report.tenantCode})`);
  lines.push(`  Legacy tenant id: ${report.legacyTenantId}`);
  lines.push(`  Master tenant id: ${report.masterTenantId}`);
  lines.push(`  Destination:      ${report.databaseName}`);
  lines.push("");
  const header = padRow(["Table", "Source rows", "Dest (before)", "Would insert/update", "Conflicts (would UPDATE)"]);
  lines.push(header);
  lines.push("-".repeat(header.length));
  let totalSource = 0;
  let totalConflicts = 0;
  for (const t of report.tables) {
    lines.push(padRow([t.table, t.sourceRows, t.destinationExistingRows, t.wouldInsertOrUpdate, t.conflicts]));
    totalSource += t.sourceRows;
    totalConflicts += t.conflicts;
  }
  lines.push("-".repeat(header.length));
  lines.push(`Total source rows across all tables: ${totalSource}`);
  lines.push(`Total rows that already exist at the destination (would be UPDATEd, not duplicated): ${totalConflicts}`);
  lines.push("Missing: 0 (dry-run performs no writes; nothing has moved yet)");
  return lines.join("\n");
}

function formatMigrationResult(result) {
  const lines = [];
  lines.push("");
  lines.push(`Migrated legacy tenant ${result.legacyTenantId} -> ${result.databaseName}`);
  const header = padRow(["Table", "Status", "Rows migrated"]);
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const t of result.tables) {
    lines.push(padRow([t.table, t.skipped ? `SKIPPED (${t.reason})` : "OK", t.rowsMigrated]));
    if (t.selfReferentialBackfilled !== undefined) {
      lines.push(`    parentDocumentId backfilled: ${t.selfReferentialBackfilled}`);
    }
    if (t.globalUserIndex) {
      lines.push(
        `    GlobalUserIndex: considered=${t.globalUserIndex.usersConsidered} created=${t.globalUserIndex.indexRowsCreated} conflicts=${t.globalUserIndex.conflicts.length}`,
      );
      for (const c of t.globalUserIndex.conflicts) {
        lines.push(`      CONFLICT: ${JSON.stringify(c)}`);
      }
    }
  }
  return lines.join("\n");
}

function formatVerificationReport(report) {
  const lines = [];
  lines.push("");
  lines.push(`Verification for legacy tenant ${report.legacyTenantId} -> ${report.databaseName}`);
  lines.push("");
  const header = padRow(["Table", "Source count", "Dest count", "Match"]);
  lines.push(header);
  lines.push("-".repeat(header.length));
  let allMatch = true;
  for (const r of report.rowCounts) {
    lines.push(padRow([r.table, r.sourceCount, r.destCount, r.match ? "OK" : "MISMATCH"]));
    if (!r.match) allMatch = false;
  }
  lines.push("");
  lines.push("Referential integrity:");
  let allZero = true;
  for (const f of report.integrity) {
    if (f.missing > 0) allZero = false;
    lines.push(`  ${f.check} = ${f.missing}`);
  }
  lines.push("");
  lines.push(allMatch && allZero ? "RESULT: VERIFIED — all row counts match and no referential integrity violations." : "RESULT: ISSUES FOUND — see mismatches/violations above. Do not consider this tenant fully migrated.");
  return lines.join("\n");
}

function padRow(cells) {
  return cells.map((c) => String(c).padEnd(28)).join("");
}

module.exports = { formatSkippedTenants, formatDryRunReport, formatMigrationResult, formatVerificationReport };
