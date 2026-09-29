import { strict as assert } from "node:assert";
import type { CsvRow } from "../src/parseCsv";
import { runAudit } from "../src/audit";

/**
 * Focused checks for the "Stimulus/Reader Fees On External Protocols"
 * table. External protocols should never bill a Stimulus/Response
 * Equipment fee or a Research Report Reader (Neuroreader) fee, at either
 * rate. A protocol counts as external for an event when the event itself
 * bills the external MRI rate, under either label, or when another event
 * in the upload bills that exact protocol number at the external rate.
 *
 * Builds the rows inline. Run from `npm test`; it throws on the first
 * failed assertion.
 */

const EXTERNAL_LABELS = [
  "Human MRI (industry/external)",
  "Human MRI (external)",
];

const STIMULUS_FEES = [
  "Stimulus/Response Equipment Usage Fee",
  "Stimulus/Response Equipment Usage Fee (Ind)",
];

const READER_FEES = [
  "Research Report Reader Fee",
  "Research Report Reader Fee (Industry)",
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

/** The table's rows for an upload, with no CAMS or REDCap data. */
function feesOnExternalProtocols(dogfishRows: CsvRow[]) {
  return runAudit(dogfishRows, [], []).feesOnExternalProtocols;
}

// Each external label, on the same event as each rate of each fee, gives
// one row that says the external rate was billed on this event.
for (const label of EXTERNAL_LABELS) {
  for (const [fee, feeName] of [
    ...STIMULUS_FEES.map((f) => [f, "Stimulus"]),
    ...READER_FEES.map((f) => [f, "Neuroreader"]),
  ]) {
    const rows = feesOnExternalProtocols([
      dogfishRow({ "Event ID": "S1", "Protocol Number": "500001", "Project Title": "Ext study", Scanner: "SC3T", Service: label }),
      dogfishRow({ "Event ID": "S1", "Protocol Number": "500001", "Project Title": "Ext study", Scanner: "SC3T", Service: fee }),
    ]);
    assert.deepEqual(
      rows,
      [
        {
          eventId: "S1",
          protocolNumber: "500001",
          projectTitle: "Ext study",
          scanTime: "2026-07-01 09:00:00",
          scanner: "SC3T",
          feesBilled: feeName,
          externalRateBilledOn: "This event",
        },
      ],
      `${fee} with ${label}`
    );
  }
}

// A fee on another event of the same exact protocol number is listed, as
// "Another event". That event's own MRI line may be at any rate, or
// missing. A fee on a protocol number that differs only by a suffix is
// not listed: protocol numbers are not normalized.
for (const label of EXTERNAL_LABELS) {
  const rows = feesOnExternalProtocols([
    dogfishRow({ "Event ID": "O1", "Protocol Number": "500001", Service: label }),
    dogfishRow({ "Event ID": "O2", "Protocol Number": "500001", Service: "Human MRI" }),
    dogfishRow({ "Event ID": "O2", "Protocol Number": "500001", Service: READER_FEES[0] }),
    dogfishRow({ "Event ID": "O3", "Protocol Number": "500001", Service: STIMULUS_FEES[1] }),
    dogfishRow({ "Event ID": "O4", "Protocol Number": "500001-B", Service: "Human MRI" }),
    dogfishRow({ "Event ID": "O4", "Protocol Number": "500001-B", Service: STIMULUS_FEES[0] }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.eventId, r.feesBilled, r.externalRateBilledOn]),
    [
      ["O2", "Neuroreader", "Another event"],
      ["O3", "Stimulus", "Another event"],
    ],
    `other events of a protocol billed at ${label}`
  );
}

// The same, the other way round: an external scan on "500001-B" does not
// mark a fee on "500001".
{
  const rows = feesOnExternalProtocols([
    dogfishRow({ "Event ID": "B1", "Protocol Number": "500001-B", Service: EXTERNAL_LABELS[0] }),
    dogfishRow({ "Event ID": "B2", "Protocol Number": "500001", Service: "Human MRI" }),
    dogfishRow({ "Event ID": "B2", "Protocol Number": "500001", Service: READER_FEES[1] }),
  ]);
  assert.deepEqual(rows, []);
}

// An external event with no fee gives no row, and neither does a fee on a
// protocol that is never billed at the external rate.
{
  const rows = feesOnExternalProtocols([
    dogfishRow({ "Event ID": "N1", "Protocol Number": "500002", Service: EXTERNAL_LABELS[0] }),
    dogfishRow({ "Event ID": "N2", "Protocol Number": "500003", Service: EXTERNAL_LABELS[1] }),
    dogfishRow({ "Event ID": "N3", "Protocol Number": "500004", Service: "Human MRI (Industry/CHOP)" }),
    dogfishRow({ "Event ID": "N3", "Protocol Number": "500004", Service: STIMULUS_FEES[1] }),
    dogfishRow({ "Event ID": "N3", "Protocol Number": "500004", Service: READER_FEES[1] }),
    dogfishRow({ "Event ID": "N4", "Protocol Number": "500005", Service: "Human MRI" }),
    dogfishRow({ "Event ID": "N4", "Protocol Number": "500005", Service: STIMULUS_FEES[0] }),
  ]);
  assert.deepEqual(rows, []);
}

// A no-show on an external protocol does not make it external, and a
// no-show row never gives a row of its own.
{
  const rows = feesOnExternalProtocols([
    dogfishRow({ "Event ID": "NS1", "Protocol Number": "500006", Service: "No Show/Cancellation Fee" }),
    dogfishRow({ "Event ID": "NS2", "Protocol Number": "500006", Service: "Human MRI" }),
    dogfishRow({ "Event ID": "NS2", "Protocol Number": "500006", Service: STIMULUS_FEES[0] }),
  ]);
  assert.deepEqual(rows, []);
}

// Both fees on one event give one row that names both, in a fixed order,
// whichever rate each was billed at.
{
  const rows = feesOnExternalProtocols([
    dogfishRow({ "Event ID": "BF", "Protocol Number": "500007", Service: READER_FEES[0] }),
    dogfishRow({ "Event ID": "BF", "Protocol Number": "500007", Service: EXTERNAL_LABELS[1] }),
    dogfishRow({ "Event ID": "BF", "Protocol Number": "500007", Service: STIMULUS_FEES[1] }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.eventId, r.feesBilled, r.externalRateBilledOn]),
    [["BF", "Stimulus, Neuroreader", "This event"]]
  );
}

// Rows are sorted by protocol number (numeric-aware), then Scan Time,
// then Event ID (numeric-aware), not in upload order.
{
  const early = "2026-07-01 09:00:00";
  const late = "2026-07-02 09:00:00";
  const rows = feesOnExternalProtocols([
    dogfishRow({ "Event ID": "ext-10", "Protocol Number": "10-0001", Service: EXTERNAL_LABELS[0] }),
    dogfishRow({ "Event ID": "ext-9", "Protocol Number": "9-0001", Service: EXTERNAL_LABELS[0] }),
    dogfishRow({ "Event ID": "10", "Protocol Number": "10-0001", "Scan Time": late, Service: STIMULUS_FEES[0] }),
    dogfishRow({ "Event ID": "11", "Protocol Number": "10-0001", "Scan Time": early, Service: STIMULUS_FEES[0] }),
    dogfishRow({ "Event ID": "9", "Protocol Number": "10-0001", "Scan Time": early, Service: READER_FEES[0] }),
    dogfishRow({ "Event ID": "12", "Protocol Number": "9-0001", "Scan Time": late, Service: READER_FEES[0] }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.protocolNumber, r.scanTime, r.eventId]),
    [
      ["9-0001", late, "12"],
      ["10-0001", early, "9"],
      ["10-0001", early, "11"],
      ["10-0001", late, "10"],
    ]
  );
}

console.log("audit external-protocol fee checks: all assertions passed");
