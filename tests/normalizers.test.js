const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../src/services/ocr/normalizers");

test("amounts: western, Indian, European grouping and currency prefixes", () => {
  assert.equal(N.parseAmount("25,000.00").normalized, "25000.00");
  assert.equal(N.parseAmount("₹ 29,500.00").normalized, "29500.00");
  assert.equal(N.parseAmount("Rs. 1,25,000.50").normalized, "125000.50");
  assert.equal(N.parseAmount("1.234,50").normalized, "1234.50");
  assert.equal(N.parseAmount("(1,000.00)").normalized, "-1000.00");
});
test("amounts: lone 3-digit group is flagged ambiguous, not guessed silently", () => {
  const r = N.parseAmount("1,234"); assert.equal(r.ok, true); assert.equal(r.ambiguous, true);
  assert.equal(N.parseAmount("12O0.00").ok, false); // letter O is NOT silently turned into 0
});
test("dates: explicit day-first, ISO, named month; impossible dates rejected", () => {
  assert.equal(N.parseDate("18-09-2026").iso, "2026-09-18");
  assert.equal(N.parseDate("2026/09/18").iso, "2026-09-18");
  assert.equal(N.parseDate("18 Sep 2026").iso, "2026-09-18");
  assert.equal(N.parseDate("Sep 18, 2026").iso, "2026-09-18");
  assert.equal(N.parseDate("31-02-2026").ok, false);
  assert.equal(N.parseDate("05-06-2026").ambiguous, true);
  assert.equal(N.parseDate("05-06-2026", { dayFirst: false }).iso, "2026-05-06");
});
test("GSTIN: format validated, checksum reported as a warning not a rejection", () => {
  const ok = N.validateGstin("27AAPFU0939F1ZV"); // well-known sample with valid checksum
  assert.equal(ok.valid, true); assert.equal(ok.checksum, true);
  const fmtOnly = N.validateGstin("21AABCS4821H1Z8");
  assert.equal(fmtOnly.valid, true); assert.equal(fmtOnly.checksum, false);
  assert.equal(N.validateGstin("21AABCS4821H1").valid, false);
});
test("GSTIN: OCR-confusion alternatives are only offered when they fully validate", () => {
  const alts = N.gstinAlternatives("27AAPFU0939F1ZV".replace("0939", "O939"));
  assert.deepEqual(alts, ["27AAPFU0939F1ZV"]);
  assert.deepEqual(N.gstinAlternatives("21AABCS4821H1Z8"), []);
});
test("stripTrailingLabels removes only labels supplied by the caller", () => {
  assert.equal(N.stripTrailingLabels("PH-INV-1 Invoice Date: 18-09-2026", ["Invoice Date"]), "PH-INV-1");
  assert.equal(N.stripTrailingLabels("Acme Date Ltd", []), "Acme Date Ltd");
});
