import { strict as assert } from "node:assert";
import type { CsvRow } from "../src/parseCsv";
import { runAudit } from "../src/audit";

/**
 * Focused checks for the Excess Late Cancellations report: each protocol
 * is allowed 2 "No Show/Cancellation Fee" events per calendar month (the
 * month taken from Scan Time); every later cancellation event that month
 * is reported, one row per event. Protocols are grouped by their exact,
 * un-normalized Dogfish Protocol Number, and cancellation rows are
 * grouped into events by Event ID.
 *
 * The fixture CSVs in test_set_1/ have no protocol over the limit in a
 * month, so this file builds the rows inline. Run from `npm test`; it
 * throws on the first failed assertion.
 */

const CANCEL = "No Show/Cancellation Fee";

function cancelRow(overrides: Record<string, string>): CsvRow {
  return {
    "Event ID": "E",
    "Protocol Number": "100000",
    "Protocol Type": "Human",
    "Project Title": "Synthetic",
    "Scan Time": "2026-07-01 09:00:00",
    Scanner: "PAV10",
    Service: CANCEL,
    Quantity: "1",
    "Mandatory Service": "N/A",
    "Scheduling User": "",
    "Check-In User": "",
    "Session Notes": "",
    ...overrides,
  };
}

/** Runs the audit with only Dogfish rows — CAMS/REDCap are irrelevant to
 * this report, and cancellation rows never reach the violation engine. */
function lateCancellations(rows: CsvRow[]) {
  return runAudit(rows, [], []).excessLateCancellations;
}

// At the limit: 2 cancellation events in a month raise nothing.
{
  const out = lateCancellations([
    cancelRow({ "Event ID": "A1", "Protocol Number": "200001", "Scan Time": "2026-07-03 09:00:00" }),
    cancelRow({ "Event ID": "A2", "Protocol Number": "200001", "Scan Time": "2026-07-10 09:00:00" }),
  ]);
  assert.deepEqual(out, []);
}

// Over the limit: the 3rd and 4th events (by Scan Time) are reported,
// each carrying the month's full cancellation count.
{
  const out = lateCancellations([
    cancelRow({ "Event ID": "B4", "Protocol Number": "200002", "Scan Time": "2026-07-28 09:00:00" }),
    cancelRow({ "Event ID": "B1", "Protocol Number": "200002", "Scan Time": "2026-07-02 09:00:00" }),
    cancelRow({ "Event ID": "B3", "Protocol Number": "200002", "Scan Time": "2026-07-20 09:00:00" }),
    cancelRow({ "Event ID": "B2", "Protocol Number": "200002", "Scan Time": "2026-07-11 09:00:00" }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((r) => r.eventId),
    ["B3", "B4"]
  );
  assert.ok(out.every((r) => r.month === "2026-07"));
  assert.ok(out.every((r) => r.cancellationsInMonth === 4));
  assert.ok(out.every((r) => r.protocolNumber === "200002"));
}

// The allowance resets each calendar month: 2 in July and 2 in August
// for one protocol raise nothing; 3 in July and 1 in August flag only
// the one July event past the limit.
{
  const clear = lateCancellations([
    cancelRow({ "Event ID": "C1", "Protocol Number": "200003", "Scan Time": "2026-07-04 09:00:00" }),
    cancelRow({ "Event ID": "C2", "Protocol Number": "200003", "Scan Time": "2026-07-05 09:00:00" }),
    cancelRow({ "Event ID": "C3", "Protocol Number": "200003", "Scan Time": "2026-08-04 09:00:00" }),
    cancelRow({ "Event ID": "C4", "Protocol Number": "200003", "Scan Time": "2026-08-05 09:00:00" }),
  ]);
  assert.deepEqual(clear, []);

  const out = lateCancellations([
    cancelRow({ "Event ID": "D1", "Protocol Number": "200004", "Scan Time": "2026-07-04 09:00:00" }),
    cancelRow({ "Event ID": "D2", "Protocol Number": "200004", "Scan Time": "2026-07-05 09:00:00" }),
    cancelRow({ "Event ID": "D3", "Protocol Number": "200004", "Scan Time": "2026-07-06 09:00:00" }),
    cancelRow({ "Event ID": "D4", "Protocol Number": "200004", "Scan Time": "2026-08-05 09:00:00" }),
  ]);
  assert.deepEqual(
    out.map((r) => ({ eventId: r.eventId, month: r.month, n: r.cancellationsInMonth })),
    [{ eventId: "D3", month: "2026-07", n: 3 }]
  );
}

// Protocols are grouped by their raw Dogfish Protocol Number, with no
// normalization: "819126" (x2) and "819126-C" (x1) are three rows but
// two distinct protocols, so neither is over the limit.
{
  const out = lateCancellations([
    cancelRow({ "Event ID": "P1", "Protocol Number": "819126", "Scan Time": "2026-07-02 09:00:00" }),
    cancelRow({ "Event ID": "P2", "Protocol Number": "819126", "Scan Time": "2026-07-09 09:00:00" }),
    cancelRow({ "Event ID": "P3", "Protocol Number": "819126-C", "Scan Time": "2026-07-16 09:00:00" }),
  ]);
  assert.deepEqual(out, []);
}

// Cancellation rows are collapsed into events by Event ID first: three
// rows sharing two Event IDs are two events, which is not over the limit.
{
  const out = lateCancellations([
    cancelRow({ "Event ID": "M1", "Protocol Number": "200005", "Scan Time": "2026-07-02 09:00:00", Quantity: "1" }),
    cancelRow({ "Event ID": "M1", "Protocol Number": "200005", "Scan Time": "2026-07-02 09:00:00", Quantity: "1" }),
    cancelRow({ "Event ID": "M2", "Protocol Number": "200005", "Scan Time": "2026-07-09 09:00:00" }),
  ]);
  assert.deepEqual(out, []);
}

// Rows that cannot be tied to a specific event, protocol, or month are
// skipped: a blank Event ID, a blank Protocol Number, and a Scan Time
// with no "YYYY-MM" prefix. With those three ignored, only two real
// events remain, so nothing is reported.
{
  const out = lateCancellations([
    cancelRow({ "Event ID": "", "Protocol Number": "200006", "Scan Time": "2026-07-01 09:00:00" }),
    cancelRow({ "Event ID": "K1", "Protocol Number": "", "Scan Time": "2026-07-02 09:00:00" }),
    cancelRow({ "Event ID": "K2", "Protocol Number": "200006", "Scan Time": "unknown" }),
    cancelRow({ "Event ID": "K3", "Protocol Number": "200006", "Scan Time": "2026-07-03 09:00:00" }),
    cancelRow({ "Event ID": "K4", "Protocol Number": "200006", "Scan Time": "2026-07-04 09:00:00" }),
  ]);
  assert.deepEqual(out, []);
}

// A non-cancellation service is never counted, even in bulk.
{
  const out = lateCancellations([
    cancelRow({ "Event ID": "S1", "Protocol Number": "200007", Service: "Human MRI", "Scan Time": "2026-07-02 09:00:00" }),
    cancelRow({ "Event ID": "S2", "Protocol Number": "200007", Service: "Human MRI", "Scan Time": "2026-07-03 09:00:00" }),
    cancelRow({ "Event ID": "S3", "Protocol Number": "200007", Service: "Human MRI", "Scan Time": "2026-07-04 09:00:00" }),
  ]);
  assert.deepEqual(out, []);
}

// Output rows are ordered by Protocol Number, then Month, then Scan Time,
// then Event ID — across protocols and months in one run.
{
  const out = lateCancellations([
    // protocol 200009, August: 3 events -> 1 extra (Z3)
    cancelRow({ "Event ID": "Z1", "Protocol Number": "200009", "Scan Time": "2026-08-02 09:00:00" }),
    cancelRow({ "Event ID": "Z2", "Protocol Number": "200009", "Scan Time": "2026-08-03 09:00:00" }),
    cancelRow({ "Event ID": "Z3", "Protocol Number": "200009", "Scan Time": "2026-08-04 09:00:00" }),
    // protocol 200008, July: 3 events -> 1 extra (Y3)
    cancelRow({ "Event ID": "Y1", "Protocol Number": "200008", "Scan Time": "2026-07-02 09:00:00" }),
    cancelRow({ "Event ID": "Y2", "Protocol Number": "200008", "Scan Time": "2026-07-03 09:00:00" }),
    cancelRow({ "Event ID": "Y3", "Protocol Number": "200008", "Scan Time": "2026-07-04 09:00:00" }),
  ]);
  assert.deepEqual(
    out.map((r) => `${r.protocolNumber} ${r.month} ${r.eventId}`),
    ["200008 2026-07 Y3", "200009 2026-08 Z3"]
  );
}

console.log("audit late-cancellation checks: all assertions passed");
