import { strict as assert } from "node:assert";
import type { CsvRow } from "../src/parseCsv";
import { runAudit, INDUSTRY_FEE_RATE_START, VIOLATION_ISSUES } from "../src/audit";
import type { ViolationRow } from "../src/types";
import { runSanityChecks, FILE_SCHEMAS } from "../src/sanityChecks";

/**
 * Focused checks for three Dogfish services added in September 2026:
 *
 * - "Human MRI (industry/external)", the new name of "Human MRI
 *   (external)". The audit accepts both labels as the external MRI rate,
 *   and never flags an event billed at it as industry billed as
 *   government.
 * - "Research Report Reader Fee (Industry)" and "Stimulus/Response
 *   Equipment Usage Fee (Ind)", the industry rates of the two ancillary
 *   fees. They replace the "(Industry/CHOP)" labels the audit had before,
 *   which never existed in Dogfish. A standard fee on an
 *   industry-sponsored protocol is flagged only for scans on or after
 *   INDUSTRY_FEE_RATE_START.
 *
 * Builds the rows inline. Run from `npm test`; it throws on the first
 * failed assertion.
 */

const EXTERNAL_LABELS = [
  "Human MRI (industry/external)",
  "Human MRI (external)",
];

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

/** The names of the checks that flagged a violation row: a boolean check
 * that is `true`, or a rate check that names a disagreeing source. */
function trueFlags(row: Partial<ViolationRow>): string[] {
  return VIOLATION_ISSUES.filter(({ flag }) => row[flag])
    .map(({ flag }) => flag)
    .sort();
}

/** The Service values the Dogfish sanity check reports as unrecognized. */
function unrecognizedServices(services: string[]): string[] {
  const rows = services.map((service) => dogfishRow({ Service: service }));
  const result = runSanityChecks(FILE_SCHEMAS.dogfish, {
    fields: Object.keys(rows[0]),
    rows,
  });
  return result.unrecognizedValues
    .filter((issue) => issue.column === "Service")
    .map((issue) => issue.value)
    .sort();
}

// The sanity check knows the three new labels and the old external label,
// and reports the removed "(Industry/CHOP)" fee labels as unrecognized.
{
  assert.deepEqual(
    unrecognizedServices([
      ...EXTERNAL_LABELS,
      "Research Report Reader Fee (Industry)",
      "Stimulus/Response Equipment Usage Fee (Ind)",
    ]),
    []
  );
  assert.deepEqual(
    unrecognizedServices([
      "Research Report Reader Fee (Industry/CHOP)",
      "Stimulus/Response Equipment Usage Fee (Industry/CHOP)",
    ]),
    [
      "Research Report Reader Fee (Industry/CHOP)",
      "Stimulus/Response Equipment Usage Fee (Industry/CHOP)",
    ]
  );
}

// Both external labels reach the external events table, including a
// no-show row, when both appear in the same upload.
{
  const result = runAudit(
    [
      dogfishRow({ "Event ID": "X1", "Protocol Number": "500001", Service: EXTERNAL_LABELS[0] }),
      dogfishRow({ "Event ID": "X2", "Protocol Number": "500002", Service: EXTERNAL_LABELS[1] }),
      dogfishRow({ "Event ID": "X3", "Protocol Number": "500003", Service: "Human MRI" }),
      dogfishRow({ "Event ID": "X4", "Protocol Number": "500001", Service: "No Show/Cancellation Fee" }),
    ],
    [],
    []
  );
  assert.deepEqual(
    result.humanMriExternalEvents.map((row) => [row.eventId, row.service]),
    [
      ["X1", EXTERNAL_LABELS[0]],
      ["X2", EXTERNAL_LABELS[1]],
    ]
  );
}

for (const label of EXTERNAL_LABELS) {
  // Either external label counts as an MRI service, so a fee billed with
  // it is not an add-on without MRI.
  {
    const result = runAudit(
      [
        dogfishRow({ "Event ID": "A1", "Protocol Number": "500010", Service: label }),
        dogfishRow({ "Event ID": "A1", "Protocol Number": "500010", Service: "Stimulus/Response Equipment Usage Fee" }),
      ],
      [],
      []
    );
    assert.deepEqual(result.addOnsWithoutMri, [], `${label} should count as MRI`);
  }

  // Either external label is a human MRI service for the animal check.
  {
    const result = runAudit(
      [dogfishRow({ "Event ID": "AN", "Protocol Number": "AR500011", Service: label })],
      [camsRow("AR500011", "No")],
      []
    );
    assert.equal(result.violations.length, 1);
    assert.deepEqual(trueFlags(result.violations[0]), ["animalBilledAsHuman"]);
  }

  // An industry-sponsored protocol billed at the external rate is not
  // flagged as industry billed as government.
  {
    const result = runAudit(
      [dogfishRow({ "Event ID": "EX", "Protocol Number": "500012", Service: label })],
      [camsRow("500012", "Yes")],
      []
    );
    assert.equal(
      result.violations.length,
      0,
      `${label} on an industry protocol should not be flagged`
    );
  }
}

// The exemption covers only the external rate: plain Human MRI on an
// industry-sponsored protocol is still flagged.
{
  const result = runAudit(
    [dogfishRow({ "Event ID": "HM", "Protocol Number": "500013", Service: "Human MRI" })],
    [camsRow("500013", "Yes")],
    []
  );
  assert.equal(result.violations.length, 1);
  assert.deepEqual(trueFlags(result.violations[0]), ["industryBilledAsGovernment"]);
}

// A standard fee on an industry-sponsored protocol is flagged from
// INDUSTRY_FEE_RATE_START on, and not the day before. A Scan Time with no
// date is still checked.
{
  assert.equal(INDUSTRY_FEE_RATE_START, "2026-07-01");

  const fees: [string, string][] = [
    ["Research Report Reader Fee", "neuroreaderBilledAsGovernment"],
    ["Stimulus/Response Equipment Usage Fee", "stimulusBilledAsGovernment"],
  ];
  const scanTimes: [string, boolean][] = [
    ["2026-06-30 16:00:00", false],
    ["2026-07-01 09:00:00", true],
    ["", true],
  ];

  for (const [fee, flag] of fees) {
    for (const [scanTime, flagged] of scanTimes) {
      const result = runAudit(
        [
          dogfishRow({ "Event ID": "C1", "Protocol Number": "500020", "Scan Time": scanTime, Service: "Human MRI (Industry/CHOP)" }),
          dogfishRow({ "Event ID": "C1", "Protocol Number": "500020", "Scan Time": scanTime, Service: fee }),
        ],
        [camsRow("500020", "Yes")],
        []
      );
      assert.deepEqual(
        trueFlags(result.violations[0] ?? {}),
        flagged ? [flag] : [],
        `${fee} at Scan Time "${scanTime}"`
      );
    }
  }
}

// The cutover does not apply to the other direction: an industry-rate fee
// on a protocol CAMS does not mark industry-sponsored is flagged on any
// date.
{
  const result = runAudit(
    [
      dogfishRow({ "Event ID": "C2", "Protocol Number": "500021", "Scan Time": "2026-06-30 16:00:00", Service: "Human MRI" }),
      dogfishRow({ "Event ID": "C2", "Protocol Number": "500021", "Scan Time": "2026-06-30 16:00:00", Service: "Research Report Reader Fee (Industry)" }),
    ],
    [camsRow("500021", "No")],
    []
  );
  assert.equal(result.violations.length, 1);
  assert.deepEqual(trueFlags(result.violations[0]), ["neuroreaderBilledAsIndustry"]);
}

console.log("audit new-services checks: all assertions passed");
