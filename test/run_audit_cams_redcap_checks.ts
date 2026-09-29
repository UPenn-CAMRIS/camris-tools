import { strict as assert } from "node:assert";
import type { CsvRow } from "../src/parseCsv";
import { runAudit } from "../src/audit";
import { runSanityChecks, FILE_SCHEMAS } from "../src/sanityChecks";
import type { RateDisagreement, ViolationRow } from "../src/types";

/**
 * Focused checks for the industry/government rate checks, which compare
 * the billed rate with two sources: CAMS ("Industry Sponsored" is "Yes")
 * and REDCap (funding_type 1 or 4 is industry). Each check names the
 * sources that disagree: "CAMS", "REDCap", or "CAMS + REDCap". A source
 * with no answer (no record, or a blank funding type) never disagrees;
 * with neither answer, the check does not run.
 *
 * Also covers CHOP (REDCap pi_school 4): a non-industry CHOP study is
 * billed Human MRI (Industry/CHOP), so that rate is not an error on it,
 * and the standard Human MRI rate is. CHOP studies pay the standard
 * ancillary fees.
 *
 * Builds the rows inline. Run from `npm test`; it throws on the first
 * failed assertion.
 */

type Cams = "Yes" | "No" | "none";
type Redcap = { fundingType: string; piSchool?: string } | "none";

function dogfishRow(overrides: Record<string, string>): CsvRow {
  return {
    "Event ID": "E",
    "Protocol Number": "700000",
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

/** Runs the audit on one event billed with `services`, for protocol
 * 700000 with the given CAMS and REDCap records. The REDCap review letter
 * approves no fees, so a billed fee is also "billing extra"; the checks
 * below read the rate checks' own values. */
function audit(
  services: string[],
  cams: Cams,
  redcap: Redcap,
  scanTime = "2026-07-01 09:00:00"
) {
  return runAudit(
    services.map((service) =>
      dogfishRow({ "Event ID": "E1", "Scan Time": scanTime, Service: service })
    ),
    cams === "none"
      ? []
      : [{ "Protocol Number": "700000", "Industry Sponsored": cams }],
    redcap === "none"
      ? []
      : [
          {
            irb_protocol_number: "700000",
            camris_review_letter_complete: "2",
            fees_reviewletter___2: "0",
            fees_reviewletter___6: "0",
            funding_type: redcap.fundingType,
            pi_school: redcap.piSchool ?? "1",
          },
        ]
  );
}

/** The value of one check on the audited event: "" when the event has no
 * violation at all. */
function check(
  result: ReturnType<typeof runAudit>,
  flag: keyof ViolationRow
): RateDisagreement | boolean {
  const row = result.violations[0];
  if (!row) return "";
  return row[flag] as RateDisagreement | boolean;
}

const INDUSTRY: Redcap = { fundingType: "1" };
const INDUSTRY_FUNDING: Redcap = { fundingType: "4" };
const GOVERNMENT: Redcap = { fundingType: "2" };
const BLANK: Redcap = { fundingType: "" };

// Standard Human MRI rate: industry billed as government, by source.
{
  const cases: [Cams, Redcap, RateDisagreement][] = [
    ["Yes", INDUSTRY, "CAMS + REDCap"],
    ["Yes", GOVERNMENT, "CAMS"],
    ["No", INDUSTRY, "REDCap"],
    ["No", INDUSTRY_FUNDING, "REDCap"],
    ["No", GOVERNMENT, ""],
    ["Yes", BLANK, "CAMS"],
    ["Yes", "none", "CAMS"],
    ["none", INDUSTRY, "REDCap"],
    ["none", GOVERNMENT, ""],
    ["No", "none", ""],
  ];
  for (const [cams, redcap, expected] of cases) {
    const result = audit(["Human MRI"], cams, redcap);
    assert.equal(
      check(result, "industryBilledAsGovernment"),
      expected,
      `Human MRI, CAMS ${cams}, REDCap ${JSON.stringify(redcap)}`
    );
  }
}

// Human MRI (Industry/CHOP): government billed as industry, by source.
{
  const cases: [Cams, Redcap, RateDisagreement][] = [
    ["No", GOVERNMENT, "CAMS + REDCap"],
    ["Yes", GOVERNMENT, "REDCap"],
    ["No", INDUSTRY, "CAMS"],
    ["Yes", INDUSTRY, ""],
    ["Yes", INDUSTRY_FUNDING, ""],
    ["No", "none", "CAMS"],
    ["none", GOVERNMENT, "REDCap"],
  ];
  for (const [cams, redcap, expected] of cases) {
    const result = audit(["Human MRI (Industry/CHOP)"], cams, redcap);
    assert.equal(
      check(result, "governmentBilledAsIndustry"),
      expected,
      `Industry/CHOP, CAMS ${cams}, REDCap ${JSON.stringify(redcap)}`
    );
  }
}

// With neither CAMS nor REDCap, the rate checks do not run: no violation,
// and the event is a mismatch on both.
{
  const result = audit(["Human MRI (Industry/CHOP)"], "none", "none");
  assert.equal(result.violations.length, 0);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].noCamsMatch, true);
  assert.equal(result.mismatches[0].noActiveRedcapMatch, true);
}

// A blank REDCap funding type is its own mismatch.
{
  const result = audit(["Human MRI"], "No", BLANK);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].noRedcapFundingType, true);
  assert.equal(result.mismatches[0].noActiveRedcapMatch, false);

  const withFundingType = audit(["Human MRI"], "No", GOVERNMENT);
  assert.equal(withFundingType.mismatches.length, 0);
}

// The Disagreeing Source column carries the rate check's sources, on both
// violations tables.
{
  const result = audit(["Human MRI"], "Yes", INDUSTRY);
  assert.deepEqual(
    result.violationIssues.map((row) => [row.issue, row.source]),
    [["Industry billed as government (MRI)", "CAMS + REDCap"]]
  );
  assert.deepEqual(
    result.protocolIssues.map((row) => [row.issue, row.source, row.events]),
    [["Industry billed as government (MRI)", "CAMS + REDCap", 1]]
  );
}

// CHOP: Human MRI (Industry/CHOP) on a non-industry CHOP study is not an
// error, even though both sources say it is not industry.
{
  const chop: Redcap = { fundingType: "5", piSchool: "4" };
  const result = audit(["Human MRI (Industry/CHOP)"], "No", chop);
  assert.equal(result.violations.length, 0);
}

// CHOP: the standard Human MRI rate on a CHOP study is an error, with
// source REDCap. Not on a non-CHOP study, and not without a REDCap record.
{
  const chop: Redcap = { fundingType: "5", piSchool: "4" };
  const result = audit(["Human MRI"], "No", chop);
  assert.equal(check(result, "chopBilledAsStandard"), true);
  assert.deepEqual(
    result.violationIssues.map((row) => [row.issue, row.source]),
    [["CHOP study billed at standard MRI rate", "REDCap"]]
  );

  assert.equal(audit(["Human MRI"], "No", GOVERNMENT).violations.length, 0);
  assert.equal(audit(["Human MRI"], "No", "none").violations.length, 0);
}

// Fees: a standard fee on an industry protocol, by source, from the
// cutover date on.
{
  const reader = ["Human MRI (Industry/CHOP)", "Research Report Reader Fee"];
  assert.equal(
    check(audit(reader, "No", INDUSTRY), "neuroreaderBilledAsGovernment"),
    "REDCap"
  );
  assert.equal(
    check(audit(reader, "Yes", INDUSTRY), "neuroreaderBilledAsGovernment"),
    "CAMS + REDCap"
  );
  assert.equal(
    check(
      audit(reader, "Yes", INDUSTRY, "2026-06-30 09:00:00"),
      "neuroreaderBilledAsGovernment"
    ),
    ""
  );

  const stimulus = ["Human MRI", "Stimulus/Response Equipment Usage Fee"];
  assert.equal(
    check(audit(stimulus, "Yes", GOVERNMENT), "stimulusBilledAsGovernment"),
    "CAMS"
  );
}

// Fees: CHOP studies pay the standard fee, so an industry-rate fee on a
// non-industry CHOP study is flagged, and a standard fee is not.
{
  const chop: Redcap = { fundingType: "5", piSchool: "4" };
  const industryFee = audit(
    ["Human MRI (Industry/CHOP)", "Research Report Reader Fee (Industry)"],
    "No",
    chop
  );
  assert.equal(
    check(industryFee, "neuroreaderBilledAsIndustry"),
    "CAMS + REDCap"
  );

  const standardFee = audit(
    ["Human MRI (Industry/CHOP)", "Stimulus/Response Equipment Usage Fee"],
    "No",
    chop
  );
  assert.equal(check(standardFee, "stimulusBilledAsGovernment"), "");
  assert.equal(check(standardFee, "stimulusBilledAsIndustry"), "");
}

// The REDCap upload check requires funding_type and pi_school, and reports
// a code outside the known set.
{
  const fields = [
    "irb_protocol_number",
    "camris_review_letter_complete",
    "fees_reviewletter___2",
    "fees_reviewletter___6",
  ];
  const missing = runSanityChecks(FILE_SCHEMAS.redcap, { fields, rows: [] });
  assert.deepEqual(
    missing.missingColumns.map((issue) => issue.expected).sort(),
    ["funding_type", "pi_school"]
  );

  const row = {
    irb_protocol_number: "700000",
    camris_review_letter_complete: "2",
    fees_reviewletter___2: "0",
    fees_reviewletter___6: "0",
    funding_type: "8",
    pi_school: "4",
  };
  const unknown = runSanityChecks(FILE_SCHEMAS.redcap, {
    fields: Object.keys(row),
    rows: [row],
  });
  assert.deepEqual(
    unknown.unrecognizedValues.map((issue) => [issue.column, issue.value]),
    [["funding_type", "8"]]
  );
}

console.log("audit CAMS/REDCap rate checks: all assertions passed");
