import { strict as assert } from "node:assert";
import { strFromU8, strToU8, unzipSync } from "fflate";
import { toCsv, type Column } from "../src/csvExport";
import {
  DECISION_KEYS,
  countNeedingDecision,
  decisionColumns,
  emptyDecisionStore,
  needsDecision,
  recordDecision,
} from "../src/decisions";
import {
  applyRowCorrection,
  decodeCsvBytes,
  parseCsv,
} from "../src/parseCsv";
import {
  buildSavedAudit,
  localDate,
  localTimestamp,
  newAuditId,
  savedAuditFilename,
  scanTimeRange,
  type AuditManifest,
} from "../src/savedAudit";
import type {
  DedupedMismatchRow,
  HumanMriExternalEventRow,
  ProdevConsistencyRow,
  ProtocolIssueRow,
} from "../src/types";

/**
 * Checks for recording decisions on the results tables, and for the
 * saved-audit zip: the decision keys, the decision columns in the CSV
 * files, and the zip's manifest, inputs, and reports.
 *
 * Builds the rows inline. Run from `npm test`; it throws on the first
 * failed assertion.
 */

function protocolIssue(
  overrides: Partial<ProtocolIssueRow> = {}
): ProtocolIssueRow {
  return {
    protocolNumber: "834512",
    issue: "Industry billed as government (MRI)",
    source: "CAMS",
    events: 2,
    firstScan: "2026-09-02 08:00:00",
    lastScan: "2026-09-24 14:30:00",
    ...overrides,
  };
}

function mismatch(
  overrides: Partial<DedupedMismatchRow> = {}
): DedupedMismatchRow {
  return {
    protocolNumber: "AR123456",
    projectTitle: "Synthetic",
    noCamsMatch: false,
    noActiveRedcapMatch: true,
    noRedcapFundingType: false,
    invalidProtocolFormat: false,
    ...overrides,
  };
}

function prodevRow(
  overrides: Partial<ProdevConsistencyRow> = {}
): ProdevConsistencyRow {
  return {
    eventId: "1",
    protocolNumber: "832792-P",
    projectTitle: "Synthetic",
    scanTime: "2026-09-02 08:00:00",
    scanner: "PAV10",
    prodevServiceBilled: "",
    prodevServiceWithoutSuffix: false,
    suffixWithoutProdevService: true,
    ...overrides,
  };
}

function externalRow(
  overrides: Partial<HumanMriExternalEventRow> = {}
): HumanMriExternalEventRow {
  return {
    eventId: "1",
    protocolNumber: "500001",
    projectTitle: "Synthetic",
    scanner: "PAV10",
    service: "Human MRI (industry/external)",
    scanTime: "2026-09-02 08:00:00",
    quantity: "1",
    mandatoryService: "",
    schedulingUser: "",
    checkInUser: "",
    ...overrides,
  };
}

// Violations by Protocol: a decision belongs to the protocol and the
// issue. The disagreeing source and the event counts are not part of it.
{
  const key = DECISION_KEYS.protocolIssues;
  assert.equal(
    key(protocolIssue()),
    key(protocolIssue({ source: "CAMS + REDCap", events: 7 }))
  );
  assert.notEqual(
    key(protocolIssue()),
    key(protocolIssue({ issue: "Stimulus billing missed" }))
  );
  assert.notEqual(
    key(protocolIssue()),
    key(protocolIssue({ protocolNumber: "834513" }))
  );
}

// Mismatches: a decision belongs to the protocol and its set of failed
// checks, so a change in the failed checks needs a new decision.
{
  const key = DECISION_KEYS.mismatches;
  assert.equal(key(mismatch()), key(mismatch({ projectTitle: "Renamed" })));
  assert.notEqual(key(mismatch()), key(mismatch({ noCamsMatch: true })));
}

// Prodev Naming Consistency: a decision belongs to the protocol and the
// direction of the mismatch, and covers every event.
{
  const key = DECISION_KEYS.prodevConsistency;
  assert.equal(key(prodevRow()), key(prodevRow({ eventId: "2" })));
  assert.notEqual(
    key(prodevRow()),
    key(
      prodevRow({
        prodevServiceWithoutSuffix: true,
        suffixWithoutProdevService: false,
      })
    )
  );
}

// Human MRI (Industry/External) Events: a decision belongs to the
// protocol, and covers every event.
{
  const key = DECISION_KEYS.humanMriExternal;
  assert.equal(
    key(externalRow()),
    key(externalRow({ eventId: "2", scanner: "SC3T" }))
  );
  assert.notEqual(
    key(externalRow()),
    key(externalRow({ protocolNumber: "500001-B" }))
  );
}

// Protocol numbers and issues that contain the other's text still make
// different keys.
assert.notEqual(
  DECISION_KEYS.protocolIssues(protocolIssue({ protocolNumber: "a", issue: "b c" })),
  DECISION_KEYS.protocolIssues(protocolIssue({ protocolNumber: "a b", issue: "c" }))
);

// A decision is dated and confirmed on the day it is made, by the
// reviewer; the reason and initials are trimmed. A blank value removes
// it.
{
  const store = emptyDecisionStore();
  recordDecision(store.protocolIssues, "k", "Don't fix", "  PI confirmed  ", " DT ", "2026-09-30");
  assert.deepEqual(store.protocolIssues.get("k"), {
    value: "Don't fix",
    reason: "PI confirmed",
    decidedBy: "DT",
    decidedOn: "2026-09-30",
    confirmedBy: "DT",
    confirmedOn: "2026-09-30",
  });
  recordDecision(store.protocolIssues, "k", "", "PI confirmed", "DT", "2026-09-30");
  assert.equal(store.protocolIssues.has("k"), false);
}

// A row needs a decision when it has none, when its carried decision is
// not confirmed yet, or when it is "Don't fix" with no reason. "Fix"
// needs no reason.
{
  const decided = {
    decidedBy: "DT",
    decidedOn: "2026-09-30",
    confirmedBy: "DT",
    confirmedOn: "2026-09-30",
  };
  assert.equal(needsDecision(undefined), true);
  assert.equal(
    needsDecision({ value: "Don't fix", reason: "x", ...decided, unconfirmed: true }),
    true
  );
  assert.equal(needsDecision({ value: "Don't fix", reason: "", ...decided }), true);
  assert.equal(needsDecision({ value: "Don't fix", reason: "x", ...decided }), false);
  assert.equal(needsDecision({ value: "Fix", reason: "", ...decided }), false);
}

// One decision covers every row with its key, both in the count of rows
// still needing a decision and in the CSV.
{
  const store = emptyDecisionStore();
  const key = DECISION_KEYS.humanMriExternal;
  const rows = [
    externalRow({ eventId: "1" }),
    externalRow({ eventId: "2" }),
    externalRow({ eventId: "3", protocolNumber: "500002" }),
  ];
  assert.equal(countNeedingDecision(rows, key, store.humanMriExternal), 3);

  recordDecision(
    store.humanMriExternal,
    key(rows[0]),
    "Don't fix",
    "External site, sponsor pays",
    "DT",
    "2026-09-30"
  );
  assert.equal(countNeedingDecision(rows, key, store.humanMriExternal), 1);

  const columns: Column<HumanMriExternalEventRow>[] = [
    { header: "Event ID", get: (r) => r.eventId },
    ...decisionColumns(key, store.humanMriExternal),
  ];
  assert.equal(
    toCsv(columns, rows),
    [
      "Event ID,Decision,Reason,Decided By,Decided On,Confirmed By,Confirmed On",
      "1,Don't fix,\"External site, sponsor pays\",DT,2026-09-30,DT,2026-09-30",
      "2,Don't fix,\"External site, sponsor pays\",DT,2026-09-30,DT,2026-09-30",
      "3,,,,,,",
    ].join("\r\n")
  );
}

// The Dogfish scan range skips blank Scan Times; no Scan Time at all
// gives no range.
assert.deepEqual(
  scanTimeRange([
    { "Scan Time": "2026-09-12 10:00:00" },
    { "Scan Time": "" },
    { "Scan Time": "2026-09-01 07:30:00" },
    { "Scan Time": "2026-09-29 18:00:00" },
  ]),
  { first: "2026-09-01 07:30:00", last: "2026-09-29 18:00:00" }
);
assert.equal(scanTimeRange([{ "Scan Time": " " }, {}]), null);

// The file name gives the scan period and the save date.
assert.equal(
  savedAuditFilename(
    { first: "2026-09-01 07:30:00", last: "2026-09-29 18:00:00" },
    "2026-09-30"
  ),
  "camris_audit_2026-09-01_to_2026-09-29_saved_2026-09-30.zip"
);
assert.equal(
  savedAuditFilename(null, "2026-09-30"),
  "camris_audit_saved_2026-09-30.zip"
);

// Dates and times are local, the time with its UTC offset.
{
  const date = new Date(2026, 8, 3, 7, 5, 9);
  assert.equal(localDate(date), "2026-09-03");
  assert.match(
    localTimestamp(date),
    /^2026-09-03T07:05:09[+-]\d{2}:\d{2}$/
  );
}

// An audit ID is a version-4 UUID, different each time.
{
  const id = newAuditId();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.notEqual(id, newAuditId());
}

// The saved audit holds the inputs exactly as uploaded, with their row
// corrections in the manifest, and the reports. Applying the corrections
// to the saved input gives the text the audit ran on.
{
  // A byte-order mark and a malformed row, corrected once.
  const redcapBytes = strToU8('﻿a,b\r\n1,"x"y"\r\n2,z\r\n');
  const redcap = applyRowCorrection(
    parseCsv(decodeCsvBytes(redcapBytes)),
    0,
    '1,"x""y"'
  );
  assert.equal(redcap.corrections.length, 1);

  const { manifest, zip } = buildSavedAudit({
    auditId: "3f6c0000-0000-4000-8000-000000000000",
    createdAt: "2026-09-30T09:05:00-04:00",
    savedAt: "2026-09-30T14:12:05-04:00",
    savedBy: "DT",
    appVersion: "0fa1d4d",
    dogfishScanRange: { first: "2026-09-01 07:30:00", last: "2026-09-29 18:00:00" },
    inputs: {
      dogfish: { filename: "Dogfish_Events.csv", bytes: strToU8("d\n1\n"), corrections: [] },
      cams: { filename: "CAMS/Data.csv", bytes: strToU8("c\n1\n"), corrections: [] },
      redcap: {
        filename: "Redcap_Export.csv",
        bytes: redcapBytes,
        corrections: redcap.corrections,
      },
    },
    reports: [
      { filename: "audit_mismatches.csv", csv: "Protocol Number\r\nAR123456" },
    ],
    previous: null,
  });

  const files = unzipSync(zip);
  assert.deepEqual(Object.keys(files).sort(), [
    "inputs/cams/CAMS_Data.csv",
    "inputs/dogfish/Dogfish_Events.csv",
    "inputs/redcap/Redcap_Export.csv",
    "manifest.json",
    "reports/audit_mismatches.csv",
  ]);

  const saved = JSON.parse(strFromU8(files["manifest.json"])) as AuditManifest;
  assert.deepEqual(saved, manifest);
  assert.equal(saved.format, "camris-audit");
  assert.equal(saved.formatVersion, 2);
  assert.equal(saved.previousAudit, null);
  assert.equal(saved.savedBy, "DT");
  assert.deepEqual(saved.inputs.cams, {
    file: "inputs/cams/CAMS_Data.csv",
    filename: "CAMS/Data.csv",
    corrections: [],
  });
  assert.deepEqual(saved.reports, ["reports/audit_mismatches.csv"]);
  assert.equal(
    strFromU8(files["reports/audit_mismatches.csv"]),
    "Protocol Number\r\nAR123456"
  );

  const savedRedcap = files[saved.inputs.redcap.file];
  assert.deepEqual(savedRedcap, redcapBytes);
  const replayed = saved.inputs.redcap.corrections.reduce(
    (file, c) => applyRowCorrection(file, c.rowIndex, c.text),
    parseCsv(decodeCsvBytes(savedRedcap))
  );
  assert.equal(replayed.rawText, redcap.rawText);
  assert.equal(replayed.hasBom, true);
  assert.deepEqual(replayed.warnings, []);
}

console.log("audit decisions checks: all assertions passed");
