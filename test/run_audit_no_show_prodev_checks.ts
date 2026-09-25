import { strict as assert } from "node:assert";
import type { CsvRow } from "../src/parseCsv";
import { runAudit } from "../src/audit";

/**
 * Focused checks for the No-Shows Billed To Prodev Protocols report: every
 * "No Show/Cancellation Fee" event whose protocol is Prodev — either its
 * raw protocol number ends with "-P", "_P", or "Prodev", or another event
 * billed that exact protocol number at a Prodev tier. Protocols are
 * matched by their exact, un-normalized Dogfish Protocol Number, and
 * no-show rows are grouped into events by Event ID.
 *
 * The fixture CSVs in test_set_1/ have no no-show on a Prodev protocol,
 * so this file builds the rows inline. Run from `npm test`; it throws on
 * the first failed assertion.
 */

const NO_SHOW = "No Show/Cancellation Fee";
const TIER_1 = "Human MRI (Prodev Tier 1)";
const TIER_2 = "Human MRI (Prodev Tier 2)";

function dogfishRow(overrides: Record<string, string>): CsvRow {
  return {
    "Event ID": "E",
    "Protocol Number": "100000",
    "Protocol Type": "IRB",
    "Project Title": "Synthetic",
    "Scan Time": "2026-07-01 09:00:00",
    Scanner: "PAV10",
    Service: NO_SHOW,
    Quantity: "1",
    "Mandatory Service": "N/A",
    "Scheduling User": "",
    "Check-In User": "",
    "Session Notes": "",
    ...overrides,
  };
}

/** Runs the audit with only Dogfish rows — CAMS/REDCap are irrelevant to
 * this report. */
function noShowsOnProdev(rows: CsvRow[]) {
  return runAudit(rows, [], []).noShowsOnProdevProtocols;
}

// Each Prodev ending the naming check accepts marks the protocol Prodev,
// with no Prodev-tier billing needed.
{
  const out = noShowsOnProdev([
    dogfishRow({ "Event ID": "A1", "Protocol Number": "832792-P" }),
    dogfishRow({ "Event ID": "A2", "Protocol Number": "832793_p" }),
    dogfishRow({ "Event ID": "A3", "Protocol Number": "832794_Prodev" }),
  ]);
  assert.deepEqual(
    out.map((r) => r.eventId),
    ["A1", "A2", "A3"]
  );
  assert.ok(out.every((r) => r.prodevSuffix));
  assert.ok(out.every((r) => !r.prodevBilledOnProtocol));
  assert.ok(out.every((r) => r.prodevServicesBilled === ""));
}

// A protocol without the ending is Prodev when another event billed it at
// a Prodev tier; both tiers are listed, in tier order.
{
  const out = noShowsOnProdev([
    dogfishRow({ "Event ID": "B1", "Protocol Number": "852381-SD", Service: TIER_2 }),
    dogfishRow({ "Event ID": "B2", "Protocol Number": "852381-SD", Service: TIER_1 }),
    dogfishRow({
      "Event ID": "B3",
      "Protocol Number": "852381-SD",
      "Project Title": "Disorders of Consciousness",
      "Scan Time": "2026-07-15 10:30:00",
      Scanner: "SC3T",
    }),
  ]);
  assert.deepEqual(out, [
    {
      eventId: "B3",
      protocolNumber: "852381-SD",
      projectTitle: "Disorders of Consciousness",
      scanTime: "2026-07-15 10:30:00",
      scanner: "SC3T",
      prodevSuffix: false,
      prodevBilledOnProtocol: true,
      prodevServicesBilled: `${TIER_1}, ${TIER_2}`,
    },
  ]);
}

// Both reasons at once: a "-P" protocol that also billed a Prodev tier.
{
  const out = noShowsOnProdev([
    dogfishRow({ "Event ID": "C1", "Protocol Number": "859310-P", Service: TIER_1 }),
    dogfishRow({ "Event ID": "C2", "Protocol Number": "859310-P" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].prodevSuffix, true);
  assert.equal(out[0].prodevBilledOnProtocol, true);
  assert.equal(out[0].prodevServicesBilled, TIER_1);
}

// Not Prodev: no ending, and the protocol's other events are non-Prodev.
{
  const out = noShowsOnProdev([
    dogfishRow({ "Event ID": "D1", "Protocol Number": "819126", Service: "Human MRI" }),
    dogfishRow({ "Event ID": "D2", "Protocol Number": "819126" }),
  ]);
  assert.deepEqual(out, []);
}

// Protocols are matched by their exact number, with no normalization:
// Prodev billing on "832792-P" does not make its parent "832792" Prodev,
// and Prodev billing on "852381" does not make "852381-C" Prodev.
{
  const out = noShowsOnProdev([
    dogfishRow({ "Event ID": "N1", "Protocol Number": "832792-P", Service: TIER_2 }),
    dogfishRow({ "Event ID": "N2", "Protocol Number": "832792" }),
    dogfishRow({ "Event ID": "N3", "Protocol Number": "852381", Service: TIER_1 }),
    dogfishRow({ "Event ID": "N4", "Protocol Number": "852381-C" }),
  ]);
  assert.deepEqual(out, []);
}

// No-show rows are collapsed into events by Event ID: two rows for one
// event give one report row.
{
  const out = noShowsOnProdev([
    dogfishRow({ "Event ID": "M1", "Protocol Number": "840000-P" }),
    dogfishRow({ "Event ID": "M1", "Protocol Number": "840000-P" }),
  ]);
  assert.deepEqual(
    out.map((r) => r.eventId),
    ["M1"]
  );
}

// A no-show row with a blank Event ID or a blank Protocol Number cannot
// be tied to an event or protocol, so it is skipped.
{
  const out = noShowsOnProdev([
    dogfishRow({ "Event ID": "", "Protocol Number": "840001-P" }),
    dogfishRow({ "Event ID": "K1", "Protocol Number": "" }),
  ]);
  assert.deepEqual(out, []);
}

// Only no-show events are reported; the Prodev scans themselves are not.
{
  const out = noShowsOnProdev([
    dogfishRow({ "Event ID": "S1", "Protocol Number": "840002-P", Service: TIER_1 }),
  ]);
  assert.deepEqual(out, []);
}

// Output rows are ordered by Protocol Number, then Scan Time, then Event ID.
{
  const out = noShowsOnProdev([
    dogfishRow({ "Event ID": "Z2", "Protocol Number": "850000-P", "Scan Time": "2026-07-02 09:00:00" }),
    dogfishRow({ "Event ID": "Z1", "Protocol Number": "850000-P", "Scan Time": "2026-07-02 09:00:00" }),
    dogfishRow({ "Event ID": "Y1", "Protocol Number": "850000-P", "Scan Time": "2026-07-01 09:00:00" }),
    dogfishRow({ "Event ID": "X1", "Protocol Number": "840003-P", "Scan Time": "2026-07-09 09:00:00" }),
  ]);
  assert.deepEqual(
    out.map((r) => `${r.protocolNumber} ${r.eventId}`),
    ["840003-P X1", "850000-P Y1", "850000-P Z1", "850000-P Z2"]
  );
}

console.log("audit no-show Prodev checks: all assertions passed");
