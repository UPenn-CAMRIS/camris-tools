import { strict as assert } from "node:assert";
import type { CsvRow } from "../src/parseCsv";
import { runAudit, VIOLATION_ISSUES } from "../src/audit";
import { VIOLATION_RULE_EXPLANATIONS } from "../src/ruleExplanations";

/**
 * Focused checks for the two violations tables, which list one row per
 * error: violationIssues (one row per event and issue) and protocolIssues
 * (one row per protocol and issue). Covers the issue names and sources,
 * the sort order, and the per-protocol event counts and scan times.
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

function camsRow(protocol: string, industry: boolean): CsvRow {
  return {
    "Protocol Number": protocol,
    "Industry Sponsored": industry ? "Yes" : "No",
  };
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

const NO_FEES = { stimulus: false, neuroreader: false };

// The issue definitions, in order, with their sources.
assert.deepEqual(
  VIOLATION_ISSUES.map(({ flag, issue, source }) => [flag, issue, source]),
  [
    ["industryBilledAsGovernment", "Industry billed as government (MRI)", "CAMS"],
    ["governmentBilledAsIndustry", "Government billed as industry (MRI)", "CAMS"],
    ["animalBilledAsHuman", "Animal billed as human", "Protocol format"],
    ["humanBilledAsAnimal", "Human billed as animal", "Protocol format"],
    ["stimulusBillingMissed", "Stimulus billing missed", "REDCap letter"],
    ["stimulusBillingExtra", "Stimulus billing extra", "REDCap letter"],
    ["stimulusBilledAsGovernment", "Stimulus billed as government", "CAMS"],
    ["stimulusBilledAsIndustry", "Stimulus billed as industry", "CAMS"],
    ["neuroreaderBillingMissed", "Neuroreader billing missed", "REDCap letter"],
    ["neuroreaderBillingExtra", "Neuroreader billing extra", "REDCap letter"],
    ["neuroreaderBilledAsGovernment", "Neuroreader billed as government", "CAMS"],
    ["neuroreaderBilledAsIndustry", "Neuroreader billed as industry", "CAMS"],
    ["neuroreaderAtStellarChance", "Neuroreader billed at Stellar Chance", "Scanner"],
  ]
);

// The rule explanations list the same issue names in the same order.
assert.deepEqual(
  VIOLATION_RULE_EXPLANATIONS.slice(0, VIOLATION_ISSUES.length).map(
    (item) => item.label
  ),
  VIOLATION_ISSUES.map((definition) => definition.issue)
);

// An event with two violations gives two rows, in definition order (not
// alphabetical order), with the event's fields repeated on each.
{
  const result = runAudit(
    [
      dogfishRow({
        "Event ID": "T1",
        "Protocol Number": "500001",
        "Scan Time": "2026-07-01 09:00:00",
        Scanner: "SC3T",
      }),
      dogfishRow({
        "Event ID": "T1",
        "Protocol Number": "500001",
        "Scan Time": "2026-07-01 09:00:00",
        Scanner: "SC3T",
        Service: "Research Report Reader Fee",
      }),
    ],
    [camsRow("500001", false)],
    [redcapRow("500001", { stimulus: true, neuroreader: true })]
  );
  const event = {
    eventId: "T1",
    protocolNumber: "500001",
    scanTime: "2026-07-01 09:00:00",
    scanner: "SC3T",
  };
  assert.deepEqual(result.violationIssues, [
    { ...event, issue: "Stimulus billing missed", source: "REDCap letter" },
    { ...event, issue: "Neuroreader billed at Stellar Chance", source: "Scanner" },
  ]);
  // The per-event flag rows are unchanged: still one row for the event.
  assert.equal(result.violations.length, 1);
}

// Each row carries its issue's source: CAMS, Protocol format.
{
  const result = runAudit(
    [
      dogfishRow({ "Event ID": "S1", "Protocol Number": "500002" }),
      dogfishRow({ "Event ID": "S2", "Protocol Number": "AR500003" }),
    ],
    [camsRow("500002", true), camsRow("AR500003", false)],
    [redcapRow("500002", NO_FEES), redcapRow("AR500003", NO_FEES)]
  );
  assert.deepEqual(
    result.violationIssues.map((r) => [r.eventId, r.issue, r.source]),
    [
      ["S1", "Industry billed as government (MRI)", "CAMS"],
      ["S2", "Animal billed as human", "Protocol format"],
    ]
  );
}

// Rows sort by Event ID with digit runs compared as numbers, so "9"
// comes before "10" and "100", whatever order the events arrive in.
{
  const result = runAudit(
    ["100", "10", "9"].map((eventId) =>
      dogfishRow({ "Event ID": eventId, "Protocol Number": "500004" })
    ),
    [camsRow("500004", true)],
    [redcapRow("500004", NO_FEES)]
  );
  assert.deepEqual(
    result.violationIssues.map((r) => r.eventId),
    ["9", "10", "100"]
  );
}

// Per protocol: one row per (protocol, issue), with the number of distinct
// events, and the first and last Scan Time, ignoring blank ones. Protocol
// numbers sort with digit runs compared as numbers, so "99-1234" comes
// before "600001".
{
  const industryStimulus = "Stimulus/Response Equipment Usage Fee (Ind)";
  const result = runAudit(
    [
      // P1 and P3 bill the approved Stimulus fee; P2 misses it.
      dogfishRow({ "Event ID": "P1", "Protocol Number": "600001", "Scan Time": "2026-07-03 10:00:00" }),
      dogfishRow({ "Event ID": "P1", "Protocol Number": "600001", "Scan Time": "2026-07-03 10:00:00", Service: industryStimulus }),
      dogfishRow({ "Event ID": "P2", "Protocol Number": "600001", "Scan Time": "2026-07-01 09:00:00" }),
      dogfishRow({ "Event ID": "P3", "Protocol Number": "600001", "Scan Time": "" }),
      dogfishRow({ "Event ID": "P3", "Protocol Number": "600001", "Scan Time": "", Service: industryStimulus }),
      // A protocol whose only event has no Scan Time.
      dogfishRow({ "Event ID": "Q1", "Protocol Number": "99-1234", "Scan Time": "" }),
    ],
    [camsRow("600001", true), camsRow("99-1234", true)],
    [
      redcapRow("600001", { stimulus: true, neuroreader: false }),
      redcapRow("99-1234", NO_FEES),
    ]
  );
  assert.deepEqual(result.protocolIssues, [
    {
      protocolNumber: "99-1234",
      issue: "Industry billed as government (MRI)",
      source: "CAMS",
      events: 1,
      firstScan: "",
      lastScan: "",
    },
    {
      protocolNumber: "600001",
      issue: "Industry billed as government (MRI)",
      source: "CAMS",
      events: 3,
      firstScan: "2026-07-01 09:00:00",
      lastScan: "2026-07-03 10:00:00",
    },
    {
      protocolNumber: "600001",
      issue: "Stimulus billing missed",
      source: "REDCap letter",
      events: 1,
      firstScan: "2026-07-01 09:00:00",
      lastScan: "2026-07-01 09:00:00",
    },
  ]);
}

// Every ViolationRow boolean flag has an issue definition, so no flag
// can drop out of the tables. The compiler checks this too (the Record
// in audit.ts); this catches it at run time from a real row.
{
  const result = runAudit(
    [dogfishRow({ "Event ID": "F1", "Protocol Number": "500005" })],
    [camsRow("500005", true)],
    [redcapRow("500005", NO_FEES)]
  );
  assert.equal(result.violations.length, 1);
  const booleanFields = Object.entries(result.violations[0])
    .filter(([, value]) => typeof value === "boolean")
    .map(([key]) => key)
    .sort();
  assert.deepEqual(
    booleanFields,
    VIOLATION_ISSUES.map((definition) => definition.flag).sort()
  );
}

console.log("audit violation issue checks: all assertions passed");
