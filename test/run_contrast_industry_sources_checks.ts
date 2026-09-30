import { strict as assert } from "node:assert";
import type { CsvRow } from "../src/parseCsv";
import { runContrast, suggestCode, type ContrastRow } from "../src/contrast";

/**
 * Focused checks for how the Contrast Injection Tool picks a row's code.
 * Three sources say whether the protocol is industry sponsored, each read
 * the way the Audit Tool reads it: the MRI rate Dogfish billed for the
 * same scan, CAMS ("Industry Sponsored" is "Yes"), and REDCap
 * (funding_type 1 or 4). The majority of the sources that answer wins; a
 * tie goes to the MRI service, then CAMS; with no answer there is no
 * code. A non-industry CHOP study gets CAMRIS-003, so the Industry/CHOP
 * MRI rate on a CHOP study gives no answer.
 *
 * Also covers the audit's mismatch flags on each row, and how a row is
 * matched to its Dogfish MRI event: same normalized protocol, same date,
 * nearest Scan Time.
 *
 * Builds the rows inline. Run from `npm test`; it throws on the first
 * failed assertion.
 */

type Cams = "Yes" | "No" | "none";
type Redcap = { fundingType: string; piSchool?: string } | "none";

const TECHNOLOGISTS = [{ Technologist: "Tech, A", PennKey: "atech" }];

function contrastRow(
  irbNumber: string,
  beginExamTime = "7/1/2026 09:05"
): Record<string, unknown> {
  return {
    "Begin Exam Time": beginExamTime,
    "Linked Study IRB Number": irbNumber,
    "Provider/Resource": "HUP PAV10 MR4 3T [R86020]",
    "Procedure-Related Meds": "gadoterate meglumine 20 mL",
    Technologist: "Tech, A",
    "Accession #": "A1",
  };
}

function dogfishRow(
  eventId: string,
  service: string,
  scanTime = "2026-07-01 09:00:00",
  protocolNumber = "700000"
): CsvRow {
  return {
    "Event ID": eventId,
    "Protocol Number": protocolNumber,
    "Protocol Type": "IRB",
    "Project Title": "Synthetic",
    "Scan Time": scanTime,
    Scanner: "PAV10",
    Service: service,
    Quantity: "1",
    "Mandatory Service": "",
    "Scheduling User": "",
    "Check-In User": "",
  };
}

function camsRows(cams: Cams): Record<string, unknown>[] {
  return cams === "none"
    ? []
    : [{ "Protocol Number": "700000", "Industry Sponsored": cams }];
}

function redcapRows(redcap: Redcap): CsvRow[] {
  return redcap === "none"
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
      ];
}

/** Runs the contrast tool on one contrast row for protocol 700000 with
 * the given sources. `mriService` is the MRI service Dogfish billed on
 * one event at 09:00 that day, or "none" for no Dogfish event. */
function contrast(
  mriService: string | "none",
  cams: Cams,
  redcap: Redcap
): ContrastRow {
  const result = runContrast(
    [contrastRow("700000")],
    TECHNOLOGISTS,
    camsRows(cams),
    redcapRows(redcap),
    mriService === "none" ? [] : [dogfishRow("E1", mriService)]
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

const INDUSTRY = { fundingType: "1" };
const NOT_INDUSTRY = { fundingType: "2" };

// --- suggestCode ----------------------------------------------------------

assert.equal(suggestCode([true, true, false]), "CAMRIS-051", "majority industry");
assert.equal(suggestCode([false, true, false]), "CAMRIS-003", "majority not");
assert.equal(suggestCode([true, false, undefined]), "CAMRIS-051", "tie: MRI wins");
assert.equal(suggestCode([false, true, undefined]), "CAMRIS-003", "tie: MRI wins");
assert.equal(suggestCode([undefined, true, false]), "CAMRIS-051", "tie: CAMS wins");
assert.equal(suggestCode([undefined, false, true]), "CAMRIS-003", "tie: CAMS wins");
assert.equal(suggestCode([undefined, undefined, true]), "CAMRIS-051", "one source");
assert.equal(suggestCode([undefined, undefined, undefined]), "", "no answer");

// --- All three sources ----------------------------------------------------

{
  const row = contrast("Human MRI (Industry/CHOP)", "Yes", INDUSTRY);
  assert.equal(row.code, "CAMRIS-051");
  assert.equal(row.suggestedCode, "CAMRIS-051");
  assert.deepEqual(row.saysIndustry, ["MRI service", "CAMS", "REDCap"]);
  assert.deepEqual(row.saysNotIndustry, []);
  assert.equal(row.dogfishEventId, "E1");
  assert.equal(row.mriService, "Human MRI (Industry/CHOP)");
  assert.equal(row.noDogfishMriMatch, false);
  assert.equal(row.noCamsMatch, false);
  assert.equal(row.noActiveRedcapMatch, false);
  assert.equal(row.noRedcapFundingType, false);
  assert.equal(row.invalidProtocolFormat, false);
}

{
  const row = contrast("Human MRI", "No", NOT_INDUSTRY);
  assert.equal(row.code, "CAMRIS-003");
  assert.deepEqual(row.saysNotIndustry, ["MRI service", "CAMS", "REDCap"]);
}

// The majority wins when the sources disagree, and each list names its
// sources.
{
  const row = contrast("Human MRI (Industry/CHOP)", "Yes", NOT_INDUSTRY);
  assert.equal(row.code, "CAMRIS-051");
  assert.deepEqual(row.saysIndustry, ["MRI service", "CAMS"]);
  assert.deepEqual(row.saysNotIndustry, ["REDCap"]);
}
{
  const row = contrast("Human MRI", "Yes", NOT_INDUSTRY);
  assert.equal(row.code, "CAMRIS-003");
  assert.deepEqual(row.saysIndustry, ["CAMS"]);
  assert.deepEqual(row.saysNotIndustry, ["MRI service", "REDCap"]);
}

// --- Ties -----------------------------------------------------------------

// MRI service against CAMS, no REDCap: the MRI service wins.
{
  const row = contrast("Human MRI", "Yes", "none");
  assert.equal(row.code, "CAMRIS-003");
  assert.equal(row.noActiveRedcapMatch, true);
}
// MRI service against REDCap, a blank CAMS answer: the MRI service wins.
{
  const row = contrast("Human MRI (Industry/CHOP)", "none", NOT_INDUSTRY);
  assert.equal(row.code, "CAMRIS-051");
  assert.equal(row.noCamsMatch, true);
}
// CAMS against REDCap, no Dogfish event: CAMS wins.
{
  const row = contrast("none", "Yes", NOT_INDUSTRY);
  assert.equal(row.code, "CAMRIS-051");
  assert.equal(row.noDogfishMriMatch, true);
  assert.equal(row.dogfishEventId, "");
  assert.equal(row.mriService, "");
}
{
  const row = contrast("none", "No", INDUSTRY);
  assert.equal(row.code, "CAMRIS-003");
}

// --- No answer ------------------------------------------------------------

// No source answers: no code, and every mismatch flag the audit would set.
{
  const row = contrast("none", "none", { fundingType: "" });
  assert.equal(row.code, "");
  assert.equal(row.suggestedCode, "");
  assert.equal(row.noDogfishMriMatch, true);
  assert.equal(row.noCamsMatch, true);
  assert.equal(row.noActiveRedcapMatch, false);
  assert.equal(row.noRedcapFundingType, true);
}

// A blank IRB number matches nothing, and is not a valid format.
{
  const result = runContrast(
    [contrastRow("")],
    TECHNOLOGISTS,
    camsRows("Yes"),
    redcapRows(INDUSTRY),
    [dogfishRow("E1", "Human MRI", "2026-07-01 09:00:00", "")]
  );
  const row = result.rows[0];
  assert.equal(row.code, "");
  assert.equal(row.noDogfishMriMatch, true);
  assert.equal(row.noCamsMatch, true);
  assert.equal(row.noActiveRedcapMatch, true);
  assert.equal(row.invalidProtocolFormat, true);
}

// An IRB number in no expected format is flagged, as in the audit.
{
  const result = runContrast(
    [contrastRow("TBD")],
    TECHNOLOGISTS,
    [],
    [],
    []
  );
  assert.equal(result.rows[0].invalidProtocolFormat, true);
}

// --- CHOP -----------------------------------------------------------------

// A non-industry CHOP study is billed Human MRI (Industry/CHOP), so that
// rate gives no answer on it, and contrast is CAMRIS-003.
{
  const row = contrast("Human MRI (Industry/CHOP)", "No", {
    fundingType: "2",
    piSchool: "4",
  });
  assert.equal(row.chop, true);
  assert.equal(row.code, "CAMRIS-003");
  assert.deepEqual(row.saysIndustry, []);
  assert.deepEqual(row.saysNotIndustry, ["CAMS", "REDCap"]);
}
// An industry CHOP study is still industry.
{
  const row = contrast("Human MRI (Industry/CHOP)", "Yes", {
    fundingType: "1",
    piSchool: "4",
  });
  assert.equal(row.code, "CAMRIS-051");
  assert.deepEqual(row.saysIndustry, ["CAMS", "REDCap"]);
}
// The standard MRI rate on a CHOP study still says not industry.
{
  const row = contrast("Human MRI", "none", { fundingType: "", piSchool: "4" });
  assert.equal(row.code, "CAMRIS-003");
  assert.deepEqual(row.saysNotIndustry, ["MRI service"]);
}

// --- The external rate ----------------------------------------------------

// The external rate serves external users whether or not they are
// industry, so it gives no answer, under either label.
for (const service of ["Human MRI (industry/external)", "Human MRI (external)"]) {
  const row = contrast(service, "Yes", NOT_INDUSTRY);
  assert.equal(row.mriService, service);
  assert.deepEqual(row.saysIndustry, ["CAMS"], service);
  assert.deepEqual(row.saysNotIndustry, ["REDCap"], service);
  assert.equal(row.noDogfishMriMatch, false, service);
  assert.equal(row.code, "CAMRIS-051", service);
}

// --- Matching the Dogfish MRI event ---------------------------------------

// The nearest Scan Time on the same date wins, and the protocol number is
// normalized (a "_7X" suffix is the same protocol). Add-on fees on the
// event are not listed as MRI services.
{
  const result = runContrast(
    [contrastRow("700000", "7/1/2026 12:40")],
    TECHNOLOGISTS,
    [],
    [],
    [
      dogfishRow("E1", "Human MRI", "2026-07-01 09:00:00"),
      dogfishRow("E2", "Human MRI (Industry/CHOP)", "2026-07-01 13:00:00", "700000_7X"),
      dogfishRow("E2", "Stimulus/Response Equipment Usage Fee (Ind)", "2026-07-01 13:00:00", "700000_7X"),
      dogfishRow("E3", "Human MRI", "2026-07-02 12:40:00"),
      dogfishRow("E4", "Human MRI", "2026-07-01 12:40:00", "700001"),
    ]
  );
  const row = result.rows[0];
  assert.equal(row.dogfishEventId, "E2");
  assert.equal(row.mriService, "Human MRI (Industry/CHOP)");
  assert.equal(row.code, "CAMRIS-051");
}

// Two events equally near: the earlier Scan Time wins.
{
  const result = runContrast(
    [contrastRow("700000", "7/1/2026 10:00")],
    TECHNOLOGISTS,
    [],
    [],
    [
      dogfishRow("E9", "Human MRI (Industry/CHOP)", "2026-07-01 10:30:00"),
      dogfishRow("E8", "Human MRI", "2026-07-01 09:30:00"),
    ]
  );
  assert.equal(result.rows[0].dogfishEventId, "E8");
}

// An event with no MRI service, or a no-show, is not a match.
{
  const result = runContrast(
    [contrastRow("700000")],
    TECHNOLOGISTS,
    [],
    [],
    [
      dogfishRow("E1", "Research Report Reader Fee"),
      dogfishRow("E2", "No Show/Cancellation Fee"),
    ]
  );
  assert.equal(result.rows[0].noDogfishMriMatch, true);
}

// A contrast row with no exam time cannot be matched to a date.
{
  const result = runContrast(
    [contrastRow("700000", "")],
    TECHNOLOGISTS,
    [],
    [],
    [dogfishRow("E1", "Human MRI")]
  );
  assert.equal(result.rows[0].noDogfishMriMatch, true);
}

// --- The filters are unchanged --------------------------------------------

{
  const noMeds = { ...contrastRow("700000"), "Procedure-Related Meds": "" };
  const noTech = { ...contrastRow("700000"), Technologist: "Someone, Else" };
  const result = runContrast([noMeds, noTech], TECHNOLOGISTS, [], [], []);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skippedNoMeds, 1);
  assert.equal(result.skippedNoTechMatch, 1);
}

console.log("Contrast industry source checks passed.");
