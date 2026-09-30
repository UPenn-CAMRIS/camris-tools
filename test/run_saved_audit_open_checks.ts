import { strict as assert } from "node:assert";
import { strToU8, zipSync } from "fflate";
import { toCsv, type Column } from "../src/csvExport";
import {
  DECISION_KEYS,
  DECISION_KEY_COLUMNS,
  decisionColumns,
  decisionsFromCsv,
  emptyDecisionStore,
  recordDecision,
  type Decision,
  type DecisionTableId,
} from "../src/decisions";
import {
  applyRowCorrection,
  applyRowCorrections,
  decodeCsvBytes,
  parseCsv,
} from "../src/parseCsv";
import {
  DECISION_REPORT_FILES,
  buildSavedAudit,
  openSavedAudit,
  type SavedAuditDetails,
} from "../src/savedAudit";
import type {
  DedupedMismatchRow,
  HumanMriExternalEventRow,
  ProdevConsistencyRow,
  ProtocolIssueRow,
} from "../src/types";

/**
 * Checks for opening a saved audit: reading the zip and its manifest
 * back, re-applying the saved row corrections, and reading each table's
 * decisions back from its CSV file so they match the rows on screen.
 *
 * Builds the data inline. Run from `npm test`; it throws on the first
 * failed assertion.
 */

/** Writes `rows` to CSV with the table's key columns (under the headers
 * the audit page uses) and its decision columns, reads the CSV back, and
 * returns the decisions found in it. */
function roundTrip<T>(
  table: DecisionTableId,
  keyColumns: Column<T>[],
  rows: T[],
  decisions: Map<string, Decision>
): Map<string, Decision> {
  assert.deepEqual(
    keyColumns.map((c) => c.header),
    DECISION_KEY_COLUMNS[table]
  );
  const keyFn = DECISION_KEYS[table] as (row: T) => string;
  const csv = toCsv(
    [
      { header: "Unrelated", get: () => "x" },
      ...keyColumns,
      ...decisionColumns(keyFn, decisions),
    ],
    rows
  );
  return decisionsFromCsv(table, parseCsv(csv).rows);
}

function decide(
  decisions: Map<string, Decision>,
  key: string,
  reason: string
): void {
  recordDecision(decisions, key, "Don't fix", reason, "DT", "2026-09-30");
}

// Every table's decisions read back from its CSV under the same keys the
// rows on screen give, including booleans, commas, quotes, and spaces.
{
  const store = emptyDecisionStore();

  const protocolIssues: ProtocolIssueRow[] = [
    {
      protocolNumber: " 834512 ",
      issue: "Industry billed as government (MRI)",
      source: "CAMS",
      events: 2,
      firstScan: "",
      lastScan: "",
    },
    {
      protocolNumber: "834512",
      issue: "Stimulus billing missed",
      source: "REDCap letter",
      events: 1,
      firstScan: "",
      lastScan: "",
    },
  ];
  decide(
    store.protocolIssues,
    DECISION_KEYS.protocolIssues(protocolIssues[0]),
    'PI said "federal", see ticket #1182, CAMS wrong'
  );
  assert.deepEqual(
    roundTrip(
      "protocolIssues",
      [
        { header: "Protocol Number", get: (r) => r.protocolNumber },
        { header: "Issue", get: (r) => r.issue },
      ],
      protocolIssues,
      store.protocolIssues
    ),
    store.protocolIssues
  );

  const mismatches: DedupedMismatchRow[] = [
    {
      protocolNumber: "AR123456",
      projectTitle: "",
      noCamsMatch: false,
      noActiveRedcapMatch: true,
      noRedcapFundingType: false,
      invalidProtocolFormat: false,
    },
  ];
  decide(
    store.mismatches,
    DECISION_KEYS.mismatches(mismatches[0]),
    "Animal protocol, not in REDCap"
  );
  assert.deepEqual(
    roundTrip(
      "mismatches",
      [
        { header: "Protocol Number", get: (r) => r.protocolNumber },
        { header: "No CAMS Match", get: (r) => r.noCamsMatch },
        { header: "No Active REDCap Match", get: (r) => r.noActiveRedcapMatch },
        { header: "No REDCap Funding Type", get: (r) => r.noRedcapFundingType },
        { header: "Invalid Protocol Format", get: (r) => r.invalidProtocolFormat },
      ],
      mismatches,
      store.mismatches
    ),
    store.mismatches
  );

  const prodev: ProdevConsistencyRow[] = ["1", "2"].map((eventId) => ({
    eventId,
    protocolNumber: "832792-P",
    projectTitle: "",
    scanTime: "",
    scanner: "",
    prodevServiceBilled: "",
    prodevServiceWithoutSuffix: false,
    suffixWithoutProdevService: true,
  }));
  decide(
    store.prodevConsistency,
    DECISION_KEYS.prodevConsistency(prodev[0]),
    "Pilot scans"
  );
  assert.deepEqual(
    roundTrip(
      "prodevConsistency",
      [
        { header: "Protocol Number", get: (r) => r.protocolNumber },
        {
          header: "Prodev Service Without Suffix",
          get: (r) => r.prodevServiceWithoutSuffix,
        },
        {
          header: "Suffix Without Prodev Service",
          get: (r) => r.suffixWithoutProdevService,
        },
      ],
      prodev,
      store.prodevConsistency
    ),
    store.prodevConsistency
  );

  const external: HumanMriExternalEventRow[] = ["1", "2"].map((eventId) => ({
    eventId,
    protocolNumber: "500001",
    projectTitle: "",
    scanner: "",
    service: "",
    scanTime: "",
    quantity: "",
    mandatoryService: "",
    schedulingUser: "",
    checkInUser: "",
  }));
  recordDecision(
    store.humanMriExternal,
    DECISION_KEYS.humanMriExternal(external[0]),
    "Fix",
    "",
    "KB",
    "2026-09-29"
  );
  assert.deepEqual(
    roundTrip(
      "humanMriExternal",
      [{ header: "Protocol Number", get: (r) => r.protocolNumber }],
      external,
      store.humanMriExternal
    ),
    store.humanMriExternal
  );
}

// A blank Decision is no decision; an unknown one is an error.
{
  const rows = parseCsv(
    "Protocol Number,Decision,Reason\n500001,,\n500002,Maybe,x\n"
  ).rows;
  assert.equal(decisionsFromCsv("humanMriExternal", [rows[0]]).size, 0);
  assert.throws(
    () => decisionsFromCsv("humanMriExternal", rows),
    /Human MRI \(Industry\/External\) Events table has an unknown decision, "Maybe"/
  );
}

// Recorded corrections apply again to the file as loaded; one that does
// not fit the file is an error, not silently skipped.
{
  const original = parseCsv('a,b\n1,"x"y"\n2,"z"w"\n');
  const corrected = applyRowCorrection(
    applyRowCorrection(original, 0, '1,"x""y"'),
    1,
    '2,"z""w"'
  );
  const replayed = applyRowCorrections(original, corrected.corrections);
  assert.equal(replayed.rawText, corrected.rawText);
  assert.deepEqual(replayed.corrections, corrected.corrections);
  assert.equal(applyRowCorrections(original, []), original);

  assert.throws(
    () => applyRowCorrections(original, [{ rowIndex: 9, text: "9,9" }]),
    /Row correction 1 does not fit this file/
  );
  assert.throws(
    () =>
      applyRowCorrections(corrected, [{ rowIndex: 0, text: '1,"x""y"' }]),
    /Row correction 1 does not fit this file/
  );
}

const DETAILS: SavedAuditDetails = {
  auditId: "3f6c0000-0000-4000-8000-000000000000",
  createdAt: "2026-09-30T09:05:00-04:00",
  savedAt: "2026-09-30T14:12:05-04:00",
  savedBy: "DT",
  appVersion: "0fa1d4d",
  dogfishScanRange: { first: "2026-09-01 07:30:00", last: "2026-09-29 18:00:00" },
  inputs: {
    dogfish: { filename: "Dogfish_Events.csv", bytes: strToU8("d\n1\n"), corrections: [] },
    cams: { filename: "CAMS_Data.csv", bytes: strToU8("﻿c\n1\n"), corrections: [] },
    redcap: {
      filename: "Redcap_Export.csv",
      bytes: strToU8('a,b\n1,"x"y"\n'),
      corrections: [{ rowIndex: 0, text: '1,"x""y"' }],
    },
  },
  reports: [
    { filename: DECISION_REPORT_FILES.mismatches, csv: "Protocol Number\r\nAR123456" },
    { filename: "audit_violations.csv", csv: "Event ID\r\n1" },
  ],
  previous: null,
};

// A saved audit opens to the same manifest, inputs, corrections, and
// reports it was saved with.
{
  const { manifest, zip } = buildSavedAudit(DETAILS);
  const opened = openSavedAudit(zip);
  assert.deepEqual(opened.manifest, manifest);
  assert.deepEqual(opened.inputs, DETAILS.inputs);
  assert.deepEqual(
    [...opened.reports.entries()].sort(),
    [
      ["audit_mismatches.csv", "Protocol Number\r\nAR123456"],
      ["audit_violations.csv", "Event ID\r\n1"],
    ]
  );
  const redcap = opened.inputs.redcap;
  assert.equal(
    applyRowCorrections(parseCsv(decodeCsvBytes(redcap.bytes)), redcap.corrections)
      .warnings.length,
    0
  );
}

const ALL_INPUTS = [
  "inputs/dogfish/Dogfish_Events.csv",
  "inputs/cams/CAMS_Data.csv",
  "inputs/redcap/Redcap_Export.csv",
];

/** A zip with `manifest` (an object, or raw text) and the input files at
 * `inputs`. */
function zipWithManifest(manifest: unknown, inputs = ALL_INPUTS): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(
      typeof manifest === "string" ? manifest : JSON.stringify(manifest)
    ),
  };
  for (const path of inputs) files[path] = strToU8("a\n1\n");
  return zipSync(files);
}

const GOOD_MANIFEST = buildSavedAudit(DETAILS).manifest;

// Files that are not a saved audit, or not one this version can open,
// fail with a plain-English reason.
assert.throws(
  () => openSavedAudit(strToU8("Event ID,Protocol Number\n1,2\n")),
  /not a saved audit: it could not be read as a zip file/
);
assert.throws(
  () => openSavedAudit(zipSync({ "notes.txt": strToU8("hi") })),
  /not a saved audit: it has no manifest\.json/
);
assert.throws(
  () => openSavedAudit(zipWithManifest("{not json")),
  /its manifest\.json could not be read/
);
assert.throws(
  () => openSavedAudit(zipWithManifest({ ...GOOD_MANIFEST, format: "other" })),
  /is not a CAMRIS audit manifest/
);
assert.throws(
  () => openSavedAudit(zipWithManifest({ ...GOOD_MANIFEST, formatVersion: 3 })),
  /saved by a newer version of the tool/
);
assert.throws(
  () => openSavedAudit(zipWithManifest({ ...GOOD_MANIFEST, auditId: undefined })),
  /has no auditId/
);
assert.throws(
  () =>
    openSavedAudit(
      zipWithManifest({
        ...GOOD_MANIFEST,
        inputs: {
          ...GOOD_MANIFEST.inputs,
          redcap: { ...GOOD_MANIFEST.inputs.redcap, corrections: [{ rowIndex: "0" }] },
        },
      })
    ),
  /does not describe the redcap input/
);
assert.throws(
  () => openSavedAudit(zipWithManifest(GOOD_MANIFEST, [ALL_INPUTS[0]])),
  /it is missing inputs\/cams\/CAMS_Data\.csv/
);

console.log("saved audit open checks: all assertions passed");
