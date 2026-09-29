import { strict as assert } from "node:assert";
import type { CsvRow } from "../src/parseCsv";
import { runAudit } from "../src/audit";

/**
 * Focused checks for the ancillary-fee rate rule: a Stimulus/Response
 * Equipment or Research Report Reader fee must be billed under its
 * industry-rate Dogfish service ("(Ind)" and "(Industry)") when — and only
 * when — CAMS marks the protocol industry-sponsored. This mirrors the
 * Human MRI industry/government check, applied to the two add-on fees.
 * The default Scan Time is on the day the industry fee rates took effect
 * (INDUSTRY_FEE_RATE_START); run_audit_new_services_checks.ts covers
 * scans before that date.
 *
 * The fixture CSVs in test_set_1/ contain no industry-rate ancillary
 * rows, so this file builds the rows inline. Run from `npm test`; it
 * throws on the first failed assertion.
 */

function dogfishRow(overrides: Record<string, string>): CsvRow {
  return {
    "Event ID": "E",
    "Protocol Number": "100000",
    "Protocol Type": "Human",
    "Project Title": "Synthetic",
    "Scan Time": "2026-07-01 09:00:00",
    Scanner: "PAV10",
    Service: "Human MRI",
    Quantity: "1",
    "Mandatory Service": "",
    "Scheduling User": "",
    "Check-In User": "",
    ...overrides,
  };
}

function camsRow(protocol: string, industrySponsored: string): CsvRow {
  return { "Protocol Number": protocol, "Industry Sponsored": industrySponsored };
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

/** The names of the boolean columns that are `true` on a violation row. */
function trueFlags(row: object): string[] {
  return Object.entries(row)
    .filter(([, value]) => value === true)
    .map(([key]) => key)
    .sort();
}

// A standard Stimulus fee on an industry-sponsored protocol: should have
// carried the "(Ind)" industry rate.
{
  const result = runAudit(
    [
      dogfishRow({ "Event ID": "S1", "Protocol Number": "300001", Service: "Human MRI (Industry/CHOP)" }),
      dogfishRow({ "Event ID": "S1", "Protocol Number": "300001", Service: "Stimulus/Response Equipment Usage Fee" }),
    ],
    [camsRow("300001", "Yes")],
    []
  );
  assert.equal(result.violations.length, 1);
  assert.deepEqual(trueFlags(result.violations[0]), ["stimulusBilledAsGovernment"]);
}

// An "(Ind)" Stimulus fee on a protocol CAMS does not mark
// industry-sponsored: should have carried the standard rate.
{
  const result = runAudit(
    [
      dogfishRow({ "Event ID": "S2", "Protocol Number": "300002", Service: "Human MRI" }),
      dogfishRow({ "Event ID": "S2", "Protocol Number": "300002", Service: "Stimulus/Response Equipment Usage Fee (Ind)" }),
    ],
    [camsRow("300002", "Not Reported")],
    []
  );
  assert.equal(result.violations.length, 1);
  assert.deepEqual(trueFlags(result.violations[0]), ["stimulusBilledAsIndustry"]);
}

// The Research Report Reader fee, both directions.
{
  const result = runAudit(
    [
      dogfishRow({ "Event ID": "R1", "Protocol Number": "300003", Service: "Human MRI (Industry/CHOP)" }),
      dogfishRow({ "Event ID": "R1", "Protocol Number": "300003", Service: "Research Report Reader Fee" }),
      dogfishRow({ "Event ID": "R2", "Protocol Number": "300004", Service: "Human MRI" }),
      dogfishRow({ "Event ID": "R2", "Protocol Number": "300004", Service: "Research Report Reader Fee (Industry)" }),
    ],
    [camsRow("300003", "Yes"), camsRow("300004", "No")],
    []
  );
  const r1 = result.violations.find((row) => row.eventId === "R1");
  const r2 = result.violations.find((row) => row.eventId === "R2");
  assert.deepEqual(trueFlags(r1 ?? {}), ["neuroreaderBilledAsGovernment"]);
  assert.deepEqual(trueFlags(r2 ?? {}), ["neuroreaderBilledAsIndustry"]);
}

// Correctly-rated fees raise nothing; a fee with no CAMS record is a
// mismatch, not a violation.
{
  const result = runAudit(
    [
      dogfishRow({ "Event ID": "OK1", "Protocol Number": "300005", Service: "Human MRI (Industry/CHOP)" }),
      dogfishRow({ "Event ID": "OK1", "Protocol Number": "300005", Service: "Stimulus/Response Equipment Usage Fee (Ind)" }),
      dogfishRow({ "Event ID": "OK2", "Protocol Number": "300006", Service: "Human MRI" }),
      dogfishRow({ "Event ID": "OK2", "Protocol Number": "300006", Service: "Research Report Reader Fee" }),
      dogfishRow({ "Event ID": "NC", "Protocol Number": "300007", Service: "Stimulus/Response Equipment Usage Fee (Ind)" }),
    ],
    [camsRow("300005", "Yes"), camsRow("300006", "Not Reported")],
    []
  );
  assert.equal(result.violations.length, 0);
  assert.ok(
    result.mismatches.some((m) => m.eventId === "NC" && m.noCamsMatch),
    "an ancillary fee with no CAMS record should land on the Mismatches table"
  );
}

// The "(Industry)" Reader rate still trips the Stellar Chance check.
{
  const result = runAudit(
    [
      dogfishRow({ "Event ID": "SC1", "Protocol Number": "300008", Scanner: "SC7T", Service: "Human MRI (Industry/CHOP)" }),
      dogfishRow({ "Event ID": "SC1", "Protocol Number": "300008", Scanner: "SC7T", Service: "Research Report Reader Fee (Industry)" }),
    ],
    [camsRow("300008", "Yes")],
    []
  );
  assert.equal(result.violations.length, 1);
  assert.deepEqual(trueFlags(result.violations[0]), ["neuroreaderAtStellarChance"]);
}

// An industry-rate fee counts as that fee being billed for the REDCap
// approved-vs-billed reconciliation, so an approved-and-billed fee raises
// neither "missed" nor "extra".
{
  const result = runAudit(
    [
      dogfishRow({ "Event ID": "RC1", "Protocol Number": "300009", Service: "Human MRI (Industry/CHOP)" }),
      dogfishRow({ "Event ID": "RC1", "Protocol Number": "300009", Service: "Stimulus/Response Equipment Usage Fee (Ind)" }),
    ],
    [camsRow("300009", "Yes")],
    [redcapRow("300009", { stimulus: true, neuroreader: false })]
  );
  assert.equal(result.violations.length, 0);
}

console.log("audit ancillary-fee industry-suffix checks: all assertions passed");
