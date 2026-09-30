import { strict as assert } from "node:assert";
import { strToU8, zipSync } from "fflate";
import { toCsv, type Column } from "../src/csvExport";
import {
  DECISION_KEYS,
  confirmDecision,
  decisionColumns,
  decisionFromCsvRow,
  decisionKeyFromCells,
  decisionsFromCsv,
  needsDecision,
  type Decision,
} from "../src/decisions";
import { parseCsv } from "../src/parseCsv";
import {
  THIS_AUDIT,
  carryDecisions,
  detailsFromKeyCells,
  earlierDecisionColumns,
  earlierDecisionRows,
  keyCellsFromDetails,
  readPreviousAudit,
  removedIds,
  thisAuditLabels,
  type PreviousAudit,
} from "../src/previousAudit";
import {
  DECISION_REPORT_FILES,
  EARLIER_DECISIONS_FILE,
  buildSavedAudit,
  openSavedAudit,
  type PreviousAuditRecord,
  type SavedAuditDetails,
  type ScanRange,
} from "../src/savedAudit";
import type {
  DedupedMismatchRow,
  ProdevConsistencyRow,
  ProtocolIssueRow,
} from "../src/types";

/**
 * Checks for starting an audit with a previous audit for reference: the
 * This Audit labels, filling in and confirming previous "Don't fix"
 * decisions, the Earlier Decisions Not Flagged table, and saving the
 * previous audit inside the new one.
 *
 * Builds the previous audit's CSV files inline, with the columns the
 * audit page writes. Run from `npm test`; it throws on the first failed
 * assertion.
 */

const DECISION_HEADERS =
  "This Audit,Decision,Reason,Decided By,Decided On,Confirmed By,Confirmed On";

const PREVIOUS_FILES = new Map<string, string>([
  [
    DECISION_REPORT_FILES.protocolIssues,
    [
      `Protocol Number,Issue,Disagreeing Source,Events,First Scan,Last Scan,${DECISION_HEADERS}`,
      `100001,Industry billed as government (MRI),CAMS,2,2026-08-02 09:00:00,2026-08-20 09:00:00,New,Don't fix,PI confirmed,DT,2026-08-29,DT,2026-08-29`,
      `100002,Stimulus billing missed,REDCap letter,1,2026-08-05 09:00:00,2026-08-05 09:00:00,New,Fix,Rebill,DT,2026-08-29,DT,2026-08-29`,
      `100003,Human billed as animal,Protocol format,1,2026-08-06 09:00:00,2026-08-06 09:00:00,New,,,,,,`,
      `100004,Stimulus billing extra,REDCap letter,1,2026-08-07 09:00:00,2026-08-07 09:00:00,Flagged again,Don't fix (unconfirmed),Old exception,KB,2026-07-30,,`,
    ].join("\r\n"),
  ],
  [
    DECISION_REPORT_FILES.mismatches,
    [
      `Protocol Number,Project Title,No CAMS Match,No Active REDCap Match,No REDCap Funding Type,Invalid Protocol Format,${DECISION_HEADERS}`,
      `AR123456,Mouse study,FALSE,TRUE,FALSE,FALSE,New,Don't fix,Animal protocol,DT,2026-08-29,DT,2026-08-29`,
    ].join("\r\n"),
  ],
  [
    DECISION_REPORT_FILES.prodevConsistency,
    [
      `Event ID,Protocol Number,Project Title,Scan Time,Scanner,Prodev Service Billed,Prodev Service Without Suffix,Suffix Without Prodev Service,${DECISION_HEADERS}`,
      `1,832792-P,Pilot,2026-08-03 09:00:00,PAV10,,FALSE,TRUE,New,Don't fix,Pilot scans,DT,2026-08-29,DT,2026-08-29`,
      `2,832792-P,Pilot,2026-08-10 09:00:00,PAV10,,FALSE,TRUE,New,Don't fix,Pilot scans,DT,2026-08-29,DT,2026-08-29`,
      // Two events of one key with different decisions: only an edited
      // file has this.
      `3,832793-P,Pilot,2026-08-11 09:00:00,PAV10,,FALSE,TRUE,New,Don't fix,Fine,DT,2026-08-29,DT,2026-08-29`,
      `4,832793-P,Pilot,2026-08-12 09:00:00,PAV10,,FALSE,TRUE,New,Fix,Rebill,DT,2026-08-29,DT,2026-08-29`,
    ].join("\r\n"),
  ],
  [
    DECISION_REPORT_FILES.humanMriExternal,
    [
      `Event ID,Protocol Number,Project Title,Scanner,Service,Scan Time,Quantity,Mandatory Service,Scheduling User,Check-In User,${DECISION_HEADERS}`,
      `5,500001,Ext,PAV10,Human MRI (industry/external),2026-08-05 09:00:00,1,,,,New,Fix,Wrong rate,DT,2026-08-29,DT,2026-08-29`,
    ].join("\r\n"),
  ],
  [
    EARLIER_DECISIONS_FILE,
    [
      `Table,Protocol Number,Details,${DECISION_HEADERS}`,
      `Violations by Protocol,100009,Animal billed as human,"Not flagged, outside this upload's dates",Don't fix,Carried exception,DT,2026-06-30,DT,2026-07-30`,
      `Mismatches,26-9999,No CAMS Match; Invalid Protocol Format,"Not flagged, carried from an earlier audit",Don't fix,Test protocol,DT,2026-06-30,DT,2026-07-30`,
    ].join("\r\n"),
  ],
]);

const AUGUST: ScanRange = { first: "2026-08-01 07:00:00", last: "2026-08-31 18:00:00" };
const SEPTEMBER: ScanRange = { first: "2026-09-01 07:00:00", last: "2026-09-30 18:00:00" };

const RECORD: PreviousAuditRecord = {
  auditId: "a91d0000-0000-4000-8000-000000000000",
  savedAt: "2026-08-29T16:40:00-04:00",
  savedBy: "DT",
  dogfishScanRange: AUGUST,
  removedDecisions: [],
};

const previous: PreviousAudit = readPreviousAudit(RECORD, PREVIOUS_FILES);

function protocolIssue(
  protocolNumber: string,
  issue: string,
  source: ProtocolIssueRow["source"]
): ProtocolIssueRow {
  return { protocolNumber, issue, source, events: 1, firstScan: "", lastScan: "" };
}

function prodevRow(eventId: string, protocolNumber: string): ProdevConsistencyRow {
  return {
    eventId,
    protocolNumber,
    projectTitle: "",
    scanTime: "",
    scanner: "",
    prodevServiceBilled: "",
    prodevServiceWithoutSuffix: false,
    suffixWithoutProdevService: true,
  };
}

const keyOfIssue = DECISION_KEYS.protocolIssues;

// Reading the previous audit: decisions, sources, scan spans, rows
// without a decision, per-event keys, and earlier decisions.
{
  const issues = previous.entries.protocolIssues;
  const a = issues.get(keyOfIssue(protocolIssue("100001", "Industry billed as government (MRI)", "CAMS")))!;
  assert.equal(a.decision?.value, "Don't fix");
  assert.equal(a.source, "CAMS");
  assert.equal(a.wasFlagged, true);
  assert.deepEqual(a.scanSpan, { first: "2026-08-02 09:00:00", last: "2026-08-20 09:00:00" });
  assert.equal(
    issues.get(keyOfIssue(protocolIssue("100003", "Human billed as animal", "Protocol format")))!
      .decision,
    undefined
  );
  const d = issues.get(keyOfIssue(protocolIssue("100004", "Stimulus billing extra", "REDCap letter")))!;
  assert.equal(d.decision?.unconfirmed, true);

  // The two events of 832792-P are one key, spanning both scans.
  const pilot = previous.entries.prodevConsistency.get(
    DECISION_KEYS.prodevConsistency(prodevRow("1", "832792-P"))
  )!;
  assert.deepEqual(pilot.scanSpan, {
    first: "2026-08-03 09:00:00",
    last: "2026-08-10 09:00:00",
  });
  assert.equal(pilot.conflict, false);
  const conflicting = previous.entries.prodevConsistency.get(
    DECISION_KEYS.prodevConsistency(prodevRow("3", "832793-P"))
  )!;
  assert.equal(conflicting.conflict, true);
  assert.equal(conflicting.decision, undefined);

  // Earlier decisions come back under the same keys the tables use.
  const carried = issues.get(keyOfIssue(protocolIssue("100009", "Animal billed as human", "Protocol format")))!;
  assert.equal(carried.wasFlagged, false);
  assert.equal(carried.decision?.reason, "Carried exception");
  const testProtocol: DedupedMismatchRow = {
    protocolNumber: "26-9999",
    projectTitle: "",
    noCamsMatch: true,
    noActiveRedcapMatch: false,
    noRedcapFundingType: false,
    invalidProtocolFormat: true,
  };
  assert.equal(
    previous.entries.mismatches.get(DECISION_KEYS.mismatches(testProtocol))?.wasFlagged,
    false
  );

  // It keeps the files it read, to save with the next audit.
  assert.deepEqual([...previous.reports.keys()].sort(), [...PREVIOUS_FILES.keys()].sort());
}

// A version-1 previous audit has no earlier decisions; a missing decision
// table is an error.
{
  const v1 = new Map(PREVIOUS_FILES);
  v1.delete(EARLIER_DECISIONS_FILE);
  assert.equal(readPreviousAudit(RECORD, v1).reports.has(EARLIER_DECISIONS_FILE), false);
  const missing = new Map(v1);
  missing.delete(DECISION_REPORT_FILES.mismatches);
  assert.throws(
    () => readPreviousAudit(RECORD, missing),
    /The previous audit is missing audit_mismatches\.csv/
  );
}

// This Audit labels for the rows this audit flags.
const current: ProtocolIssueRow[] = [
  protocolIssue("100001", "Industry billed as government (MRI)", "CAMS + REDCap"),
  protocolIssue("100002", "Stimulus billing missed", "REDCap letter"),
  protocolIssue("200000", "Human billed as animal", "Protocol format"),
  protocolIssue("100009", "Animal billed as human", "Protocol format"),
];
{
  const labels = thisAuditLabels(
    "protocolIssues",
    current,
    keyOfIssue,
    (r) => r.source,
    previous
  );
  assert.deepEqual(
    current.map((r) => labels.get(keyOfIssue(r))),
    [
      "Flagged again, source changed (was CAMS)",
      "Flagged again (marked Fix on 2026-08-29)",
      THIS_AUDIT.new,
      THIS_AUDIT.flaggedAgain,
    ]
  );
  assert.equal(
    thisAuditLabels("prodevConsistency", [prodevRow("9", "832793-P")], DECISION_KEYS.prodevConsistency, undefined, previous)
      .get(DECISION_KEYS.prodevConsistency(prodevRow("9", "832793-P"))),
    "Flagged again (the previous audit had conflicting decisions)"
  );
  // No previous audit: no labels.
  assert.equal(
    thisAuditLabels("protocolIssues", current, keyOfIssue, (r) => r.source, null).size,
    0
  );
}

// A previous "Don't fix" is filled in, unconfirmed, on a row flagged
// again, with the original decider and date; a "Fix" or a conflict is
// not. A key is considered once.
{
  const decisions = new Map<string, Decision>();
  const considered = new Set<string>();
  const keys = current.map(keyOfIssue);
  carryDecisions(keys, previous.entries.protocolIssues, decisions, considered);
  assert.deepEqual(decisions.get(keys[0]), {
    value: "Don't fix",
    reason: "PI confirmed",
    decidedBy: "DT",
    decidedOn: "2026-08-29",
    confirmedBy: "",
    confirmedOn: "",
    unconfirmed: true,
  });
  assert.equal(decisions.has(keys[1]), false);
  assert.equal(decisions.has(keys[2]), false);
  assert.equal(decisions.get(keys[3])?.reason, "Carried exception");
  assert.equal(needsDecision(decisions.get(keys[0])), true);

  // A reviewer removes the filled-in decision; re-running does not bring
  // it back.
  decisions.delete(keys[0]);
  carryDecisions(keys, previous.entries.protocolIssues, decisions, considered);
  assert.equal(decisions.has(keys[0]), false);

  // A key that already has a decision keeps it.
  const own = new Map<string, Decision>([
    [keys[0], { value: "Fix", reason: "", decidedBy: "KB", decidedOn: "2026-09-30", confirmedBy: "KB", confirmedOn: "2026-09-30" }],
  ]);
  carryDecisions(keys, previous.entries.protocolIssues, own, new Set());
  assert.equal(own.get(keys[0])?.value, "Fix");

  // Confirming keeps the decision and its decider, and records the
  // confirmer.
  carryDecisions(keys, previous.entries.protocolIssues, decisions, new Set());
  confirmDecision(decisions, keys[0], " KB ", "2026-09-30");
  assert.deepEqual(decisions.get(keys[0]), {
    value: "Don't fix",
    reason: "PI confirmed",
    decidedBy: "DT",
    decidedOn: "2026-08-29",
    confirmedBy: "KB",
    confirmedOn: "2026-09-30",
  });
  assert.equal(needsDecision(decisions.get(keys[0])), false);
}

function flaggedNow() {
  return {
    protocolIssues: new Set(current.map(keyOfIssue)),
    mismatches: new Set<string>(),
    prodevConsistency: new Set<string>(),
    humanMriExternal: new Set<string>(),
  };
}

function describe(rows: ReturnType<typeof earlierDecisionRows>) {
  return rows.map((r) => [r.table, r.keyCells[0], r.thisAudit, r.decision.value]);
}

// Next month (September): previous decisions not flagged now. Every
// "Don't fix" moves forward; a "Fix" on August scans is dropped; a row
// with no decision, or conflicting ones, is not listed.
assert.deepEqual(
  describe(earlierDecisionRows(previous, flaggedNow(), SEPTEMBER, new Set())),
  [
    ["protocolIssues", "100004", THIS_AUDIT.outsideDates, "Don't fix"],
    ["mismatches", "AR123456", THIS_AUDIT.outsideDates, "Don't fix"],
    ["mismatches", "26-9999", THIS_AUDIT.earlier, "Don't fix"],
    ["prodevConsistency", "832792-P", THIS_AUDIT.outsideDates, "Don't fix"],
  ]
);

// The same August data re-run after fixes: rows flagged on scans this
// upload covers are resolved, and a "Fix" is listed once as resolved.
// Mismatches, with no scan times, use the previous audit's scan range.
assert.deepEqual(
  describe(earlierDecisionRows(previous, flaggedNow(), AUGUST, new Set())),
  [
    ["protocolIssues", "100004", THIS_AUDIT.resolved, "Don't fix"],
    ["mismatches", "AR123456", THIS_AUDIT.resolved, "Don't fix"],
    ["mismatches", "26-9999", THIS_AUDIT.earlier, "Don't fix"],
    ["prodevConsistency", "832792-P", THIS_AUDIT.resolved, "Don't fix"],
    ["humanMriExternal", "500001", THIS_AUDIT.resolved, "Fix"],
  ]
);

// A removed decision is not listed; no previous audit lists nothing.
{
  const removed = removedIds([
    { table: "mismatches", keyCells: ["AR123456", "FALSE", "TRUE", "FALSE", "FALSE"] },
  ]);
  assert.deepEqual(
    describe(earlierDecisionRows(previous, flaggedNow(), SEPTEMBER, removed)).map((r) => r[1]),
    ["100004", "26-9999", "832792-P"]
  );
  assert.deepEqual(earlierDecisionRows(null, flaggedNow(), SEPTEMBER, new Set()), []);
}

// The Earlier Decisions Not Flagged CSV reads back, as the next audit's
// earlier decisions, under the same keys. The ✕ column is not in it.
{
  const rows = earlierDecisionRows(previous, flaggedNow(), SEPTEMBER, new Set());
  const columns: Column<(typeof rows)[number]>[] = [
    ...earlierDecisionColumns(),
    { header: "", get: () => "", screenOnly: true },
  ];
  const csv = toCsv(columns, rows);
  assert.equal(
    csv.split("\r\n")[0],
    `Table,Protocol Number,Details,${DECISION_HEADERS}`
  );
  const files = new Map(PREVIOUS_FILES);
  files.set(EARLIER_DECISIONS_FILE, csv);
  for (const file of Object.values(DECISION_REPORT_FILES)) {
    files.set(file, PREVIOUS_FILES.get(file)!.split("\r\n")[0]);
  }
  const next = readPreviousAudit(RECORD, files);
  for (const row of rows) {
    const entry = next.entries[row.table].get(row.key);
    assert.deepEqual(entry?.keyCells, row.keyCells);
    assert.deepEqual(entry?.decision, row.decision);
    assert.equal(entry?.wasFlagged, false);
  }
}

// Details name each table's key columns after Protocol Number, and read
// back to the same key cells.
{
  const cases: [Parameters<typeof detailsFromKeyCells>[0], string[], string][] = [
    ["protocolIssues", ["1", "Stimulus billing missed"], "Stimulus billing missed"],
    ["mismatches", ["2", "TRUE", "FALSE", "TRUE", "FALSE"], "No CAMS Match; No REDCap Funding Type"],
    ["prodevConsistency", ["3", "TRUE", "FALSE"], "Prodev Service Without Suffix"],
    ["humanMriExternal", ["4"], ""],
  ];
  for (const [table, cells, details] of cases) {
    assert.equal(detailsFromKeyCells(table, cells), details);
    assert.deepEqual(keyCellsFromDetails(table, cells[0], details), cells);
  }
  assert.throws(
    () => keyCellsFromDetails("mismatches", "2", "No Such Check"),
    /unknown Mismatches detail, "No Such Check"/
  );
  const badTable = new Map(PREVIOUS_FILES);
  badTable.set(EARLIER_DECISIONS_FILE, `Table,Protocol Number,Details,${DECISION_HEADERS}\r\nSomething,1,,,Don't fix,x,DT,,,`);
  assert.throws(
    () => readPreviousAudit(RECORD, badTable),
    /names an unknown table, "Something"/
  );
}

// An unconfirmed decision's CSV text, and reading it back. A file saved
// before Confirmed By existed gets the decider as the confirmer.
{
  const decisions = new Map<string, Decision>([
    ["k", { value: "Don't fix", reason: "x", decidedBy: "DT", decidedOn: "2026-08-29", confirmedBy: "", confirmedOn: "", unconfirmed: true }],
  ]);
  const csv = toCsv(
    [{ header: "Protocol Number", get: () => "500001" }, ...decisionColumns(() => "k", decisions)],
    [{}]
  );
  assert.equal(
    csv,
    "Protocol Number,Decision,Reason,Decided By,Decided On,Confirmed By,Confirmed On\r\n500001,Don't fix (unconfirmed),x,DT,2026-08-29,,"
  );
  assert.deepEqual(
    decisionsFromCsv("humanMriExternal", parseCsv(csv).rows).get(decisionKeyFromCells(["500001"])),
    decisions.get("k")
  );
  const [old] = parseCsv(
    "Decision,Reason,Decided By,Decided On,Confirmed On\nFix,,KB,2026-09-30,2026-09-30\n"
  ).rows;
  assert.equal(decisionFromCsvRow(old, "test")?.confirmedBy, "KB");
}

// A saved audit keeps its previous audit: the record, with the decisions
// removed in this audit, and the previous audit's CSV files.
{
  const details: SavedAuditDetails = {
    auditId: "3f6c0000-0000-4000-8000-000000000000",
    createdAt: "2026-09-30T09:05:00-04:00",
    savedAt: "2026-09-30T14:12:05-04:00",
    savedBy: "KB",
    appVersion: "0fa1d4d",
    dogfishScanRange: SEPTEMBER,
    inputs: {
      dogfish: { filename: "Dogfish_Events.csv", bytes: strToU8("d\n1\n"), corrections: [] },
      cams: { filename: "CAMS_Data.csv", bytes: strToU8("c\n1\n"), corrections: [] },
      redcap: { filename: "Redcap_Export.csv", bytes: strToU8("r\n1\n"), corrections: [] },
    },
    reports: [],
    previous: {
      record: {
        ...RECORD,
        removedDecisions: [{ table: "humanMriExternal", keyCells: ["500001"] }],
      },
      reports: [...PREVIOUS_FILES].map(([filename, csv]) => ({ filename, csv })),
    },
  };
  const { manifest, zip } = buildSavedAudit(details);
  assert.equal(manifest.formatVersion, 2);
  const opened = openSavedAudit(zip);
  assert.deepEqual(opened.manifest.previousAudit, details.previous!.record);
  assert.deepEqual(opened.previous?.record, details.previous!.record);
  assert.deepEqual(opened.previous?.reports, PREVIOUS_FILES);

  // Without a previous audit, and in a version-1 file, there is none.
  const none = openSavedAudit(buildSavedAudit({ ...details, previous: null }).zip);
  assert.equal(none.previous, null);
  const v1Manifest = { ...manifest, formatVersion: 1 } as Record<string, unknown>;
  delete v1Manifest.previousAudit;
  const v1 = openSavedAudit(
    zipSync({
      "manifest.json": strToU8(JSON.stringify(v1Manifest)),
      "inputs/dogfish/Dogfish_Events.csv": strToU8("d\n1\n"),
      "inputs/cams/CAMS_Data.csv": strToU8("c\n1\n"),
      "inputs/redcap/Redcap_Export.csv": strToU8("r\n1\n"),
    })
  );
  assert.equal(v1.previous, null);
  assert.equal(v1.manifest.previousAudit, null);

  // A damaged previous-audit record is an error.
  assert.throws(
    () =>
      openSavedAudit(
        zipSync({
          "manifest.json": strToU8(
            JSON.stringify({ ...manifest, previousAudit: { auditId: 1 } })
          ),
          "inputs/dogfish/Dogfish_Events.csv": strToU8("d\n1\n"),
          "inputs/cams/CAMS_Data.csv": strToU8("c\n1\n"),
          "inputs/redcap/Redcap_Export.csv": strToU8("r\n1\n"),
        })
      ),
    /does not describe its previous audit/
  );
}

console.log("previous audit checks: all assertions passed");
