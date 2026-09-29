import { strict as assert } from "node:assert";
import type { CsvRow } from "../src/parseCsv";
import { runAudit, VIOLATION_ISSUES } from "../src/audit";
import type { ViolationRow } from "../src/types";

/**
 * Focused checks for the Neuroreader Billing Missed rule: an approved
 * Research Report Reader fee with no matching Dogfish charge is flagged,
 * except on the SC3T and SC7T scanners (Stellar Chance), where scans
 * should not have Neuroreader services.
 *
 * Builds the rows inline. Run from `npm test`; it throws on the first
 * failed assertion.
 */

function dogfishRow(overrides: Record<string, string>): CsvRow {
  return {
    "Event ID": "E",
    "Protocol Number": "100000",
    "Protocol Type": "Human",
    "Project Title": "Synthetic",
    "Scan Time": "2026-01-01 09:00:00",
    Scanner: "PAV10",
    Service: "Human MRI",
    Quantity: "1",
    "Mandatory Service": "",
    "Scheduling User": "",
    "Check-In User": "",
    ...overrides,
  };
}

function camsRow(protocol: string): CsvRow {
  return { "Protocol Number": protocol, "Industry Sponsored": "No" };
}

function redcapRow(
  protocol: string,
  approved: { stimulus: boolean; neuroreader: boolean }
): CsvRow {
  return {
    irb_protocol_number: protocol,
    camris_review_letter_complete: "2",
    fees_reviewletter___2: approved.neuroreader ? "1" : "0",
    fees_reviewletter___6: approved.stimulus ? "1" : "0",
  };
}

/** The names of the checks that flagged a violation row: a boolean check
 * that is `true`, or a rate check that names a disagreeing source. */
function trueFlags(row: Partial<ViolationRow>): string[] {
  return VIOLATION_ISSUES.filter(({ flag }) => row[flag])
    .map(({ flag }) => flag)
    .sort();
}

// Off Stellar Chance, an approved Neuroreader fee that was never billed
// is flagged as missed.
{
  const result = runAudit(
    [dogfishRow({ "Event ID": "M1", "Protocol Number": "400001", Scanner: "PAV10" })],
    [camsRow("400001")],
    [redcapRow("400001", { stimulus: false, neuroreader: true })]
  );
  assert.equal(result.violations.length, 1);
  assert.deepEqual(trueFlags(result.violations[0]), ["neuroreaderBillingMissed"]);
}

// On SC3T or SC7T, the same approved-but-unbilled fee is not flagged.
for (const scanner of ["SC3T", "SC7T"]) {
  const result = runAudit(
    [dogfishRow({ "Event ID": "SC", "Protocol Number": "400002", Scanner: scanner })],
    [camsRow("400002")],
    [redcapRow("400002", { stimulus: false, neuroreader: true })]
  );
  assert.equal(
    result.violations.length,
    0,
    `a missing Neuroreader fee on ${scanner} should not be flagged`
  );
}

// The Stellar Chance exception covers only Neuroreader Billing Missed:
// an approved Stimulus fee that was never billed there is still flagged.
{
  const result = runAudit(
    [dogfishRow({ "Event ID": "SC7", "Protocol Number": "400003", Scanner: "SC7T" })],
    [camsRow("400003")],
    [redcapRow("400003", { stimulus: true, neuroreader: true })]
  );
  assert.equal(result.violations.length, 1);
  assert.deepEqual(trueFlags(result.violations[0]), ["stimulusBillingMissed"]);
}

console.log("audit Neuroreader missed-billing checks: all assertions passed");
