import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../src/audit";
import { decisionKeyFromCells, type DecisionTableId } from "../src/decisions";
import { DECISION_TABLE_IDS } from "../src/previousAudit";
import { prepareSavedAudit, previousAuditFromSaved } from "../src/restoreAudit";
import {
  AUDIT_INPUT_KEYS,
  SAVED_AUDIT_FORMAT_VERSION,
  openSavedAudit,
  type AuditInputKey,
} from "../src/savedAudit";

/**
 * Opens real saved audits, one or more for each format version, each one
 * saved by the app build named in its file name (see "Saved-audit
 * fixtures" in README.md). Every saved audit an earlier version wrote must
 * still open, with nothing lost; these files catch a change that breaks
 * that.
 *
 * Do not change or remove a fixture. When the format changes, add a file
 * saved by the new version, and its expectations below.
 *
 * Run from `npm test`; it throws on the first failed assertion.
 */

const DIR = join(import.meta.dirname, "fixtures", "saved-audits");

/** A decision as the fixture's audit recorded it: the key columns' text,
 * then the decision, reason, who decided, and who confirmed ("" for a
 * previous "Don't fix" not yet confirmed). */
type ExpectedDecision = [
  keyCells: string[],
  value: "Fix" | "Don't fix",
  reason: string,
  decidedBy: string,
  confirmedBy: string,
];

interface Expected {
  formatVersion: number;
  appVersion: string;
  savedBy: string;
  /** Row count of each input, after its saved row corrections. */
  rows: Record<AuditInputKey, number>;
  corrections: Record<AuditInputKey, number>;
  /** Rows in each decision table's CSV, with a decision or not. */
  considered: Record<DecisionTableId, number>;
  decisions: Record<DecisionTableId, ExpectedDecision[]>;
  /** null for an audit started without a previous audit. */
  previous: {
    savedBy: string;
    removedDecisions: number;
    /** Decision keys in the previous audit's files, for each table. */
    entries: Record<DecisionTableId, number>;
  } | null;
}

const DT = "2026-09-30";
const PROTOCOL_2025 = 'Sponsor pays the government rate, per the "2025" contract';
const ATHENA = 'Title has quotes, "Athena Study"';
const ONE_CORRECTION = { dogfish: 1, cams: 1, redcap: 0 };
const FIRST_INPUTS = { dogfish: 29, cams: 11, redcap: 7 };
const SECOND_INPUTS = { dogfish: 27, cams: 8, redcap: 6 };

const EXPECTED: Record<string, Expected> = {
  // Saved by the first build that saved audits (#20). No Confirmed By
  // column: the decider is read as the confirmer.
  "v1-5b7a243.zip": {
    formatVersion: 1,
    appVersion: "5b7a243",
    savedBy: "DT",
    rows: FIRST_INPUTS,
    corrections: ONE_CORRECTION,
    considered: { protocolIssues: 6, mismatches: 3, prodevConsistency: 1, humanMriExternal: 1 },
    decisions: {
      protocolIssues: [
        [["26-5880", "Industry billed as government (MRI)"], "Don't fix", PROTOCOL_2025, "DT", "DT"],
        [["842728", "Government billed as industry (MRI)"], "Fix", "Rebill at the government rate", "DT", "DT"],
        [["850677", "Government billed as industry (MRI)"], "Don't fix", "Approved exception", "DT", "DT"],
      ],
      mismatches: [
        [["703745", "FALSE", "TRUE", "FALSE", "FALSE"], "Don't fix", "Ex vivo, billed correctly", "DT", "DT"],
        [["825415", "FALSE", "TRUE", "FALSE", "FALSE"], "Fix", "Update CAMS", "DT", "DT"],
      ],
      prodevConsistency: [[["852381-SD", "TRUE", "FALSE"], "Don't fix", "Pilot scans, OK", "DT", "DT"]],
      humanMriExternal: [[["45084153"], "Fix", "Wrong rate", "DT", "DT"]],
    },
    previous: null,
  },
  // Saved by #23, with v1-5b7a243.zip as its previous audit. Its
  // comparison column is headed "This Audit", and one earlier decision
  // was removed with the ✕.
  "v2-7533f38-previous.zip": {
    formatVersion: 2,
    appVersion: "7533f38",
    savedBy: "MT",
    rows: SECOND_INPUTS,
    corrections: ONE_CORRECTION,
    considered: { protocolIssues: 5, mismatches: 2, prodevConsistency: 1, humanMriExternal: 1 },
    decisions: {
      protocolIssues: [
        [["842728", "Government billed as industry (MRI)"], "Fix", "Rebill, second month", "MT", "MT"],
        [["850677", "Government billed as industry (MRI)"], "Don't fix", "Approved exception", "DT", "MT"],
      ],
      mismatches: [[["825415", "FALSE", "TRUE", "FALSE", "FALSE"], "Don't fix", ATHENA, "MT", "MT"]],
      prodevConsistency: [[["852381-SD", "TRUE", "FALSE"], "Don't fix", "Pilot scans, OK", "DT", ""]],
      humanMriExternal: [],
    },
    previous: {
      savedBy: "DT",
      removedDecisions: 1,
      entries: { protocolIssues: 6, mismatches: 3, prodevConsistency: 1, humanMriExternal: 1 },
    },
  },
  // Saved by the build after #24 (Since Previous Audit), without a
  // previous audit, so without that column.
  "v2-4abf5c0.zip": {
    formatVersion: 2,
    appVersion: "4abf5c0",
    savedBy: "DT",
    rows: SECOND_INPUTS,
    corrections: ONE_CORRECTION,
    considered: { protocolIssues: 5, mismatches: 2, prodevConsistency: 1, humanMriExternal: 1 },
    decisions: {
      protocolIssues: [
        [["842728", "Government billed as industry (MRI)"], "Fix", "Rebill", "DT", "DT"],
        [["852381-SD", "Stimulus billing missed"], "Don't fix", "Stimulus included in the letter", "DT", "DT"],
      ],
      mismatches: [],
      prodevConsistency: [[["852381-SD", "TRUE", "FALSE"], "Don't fix", "Pilot scans, OK", "DT", "DT"]],
      humanMriExternal: [[["45084153"], "Fix", "Wrong rate", "DT", "DT"]],
    },
    previous: null,
  },
  // Saved by the same build, with v2-7533f38-previous.zip as its previous
  // audit: an old "This Audit" file read as a previous audit.
  "v2-4abf5c0-previous.zip": {
    formatVersion: 2,
    appVersion: "4abf5c0",
    savedBy: "AB",
    rows: FIRST_INPUTS,
    corrections: ONE_CORRECTION,
    considered: { protocolIssues: 6, mismatches: 3, prodevConsistency: 1, humanMriExternal: 1 },
    decisions: {
      protocolIssues: [
        [["26-5880", "Industry billed as government (MRI)"], "Don't fix", PROTOCOL_2025, "DT", "AB"],
        [["842728", "Neuroreader billed as government"], "Don't fix", "Neuroreader waived", "AB", "AB"],
        [["850677", "Government billed as industry (MRI)"], "Don't fix", "Approved exception", "DT", ""],
      ],
      mismatches: [
        [["703745", "FALSE", "TRUE", "FALSE", "FALSE"], "Fix", "Add to REDCap", "AB", "AB"],
        [["825415", "FALSE", "TRUE", "FALSE", "FALSE"], "Don't fix", ATHENA, "MT", ""],
      ],
      prodevConsistency: [[["852381-SD", "TRUE", "FALSE"], "Don't fix", "Pilot scans, OK", "DT", ""]],
      humanMriExternal: [],
    },
    previous: {
      savedBy: "MT",
      removedDecisions: 0,
      // 703745's mismatch was removed with the ✕, so it is not in the files.
      entries: { protocolIssues: 6, mismatches: 2, prodevConsistency: 1, humanMriExternal: 1 },
    },
  },
};

const fixtures = readdirSync(DIR).filter((f) => f.endsWith(".zip")).sort();

// Every fixture has expectations, and every expectation has its fixture.
assert.deepEqual(fixtures, Object.keys(EXPECTED).sort());

// Every format version, up to the current one, has a fixture.
for (let version = 1; version <= SAVED_AUDIT_FORMAT_VERSION; version++) {
  assert.ok(
    fixtures.some((f) => EXPECTED[f].formatVersion === version),
    `no saved-audit fixture of format version ${version}`
  );
}

for (const fixture of fixtures) {
  const expected = EXPECTED[fixture];
  const zip = new Uint8Array(readFileSync(join(DIR, fixture)));
  const where = (what: string) => `${fixture}: ${what}`;

  // Opened as the Audit page opens a saved audit.
  const prepared = prepareSavedAudit(zip);
  const { manifest } = prepared;
  assert.equal(manifest.formatVersion, expected.formatVersion, where("format version"));
  assert.equal(manifest.appVersion, expected.appVersion, where("app version"));
  assert.equal(manifest.savedBy, expected.savedBy, where("saved by"));

  for (const key of AUDIT_INPUT_KEYS) {
    const { parsed } = prepared.inputs[key];
    assert.equal(parsed.rows.length, expected.rows[key], where(`${key} rows`));
    assert.equal(parsed.warnings.length, 0, where(`${key} still has malformed rows`));
    assert.equal(parsed.corrections.length, expected.corrections[key], where(`${key} corrections`));
  }

  // The restored inputs run.
  runAudit(
    prepared.inputs.dogfish.parsed.rows,
    prepared.inputs.cams.parsed.rows,
    prepared.inputs.redcap.parsed.rows
  );

  for (const table of DECISION_TABLE_IDS) {
    assert.equal(prepared.considered[table].size, expected.considered[table], where(`${table} rows`));
    const decisions = prepared.decisions[table];
    assert.equal(decisions.size, expected.decisions[table].length, where(`${table} decisions`));
    for (const [keyCells, value, reason, decidedBy, confirmedBy] of expected.decisions[table]) {
      const decision = decisions.get(decisionKeyFromCells(keyCells));
      assert.ok(decision, where(`${table} has no decision for ${keyCells.join(", ")}`));
      assert.equal(decision.value, value, where(`${table} ${keyCells[0]} decision`));
      assert.equal(decision.reason, reason, where(`${table} ${keyCells[0]} reason`));
      assert.equal(decision.decidedBy, decidedBy, where(`${table} ${keyCells[0]} decided by`));
      assert.equal(decision.decidedOn, DT, where(`${table} ${keyCells[0]} decided on`));
      assert.equal(decision.confirmedBy, confirmedBy, where(`${table} ${keyCells[0]} confirmed by`));
      assert.equal(decision.confirmedOn, confirmedBy ? DT : "", where(`${table} ${keyCells[0]} confirmed on`));
    }
  }

  if (expected.previous === null) {
    assert.equal(prepared.previous, null, where("previous audit"));
  } else {
    assert.ok(prepared.previous, where("has no previous audit"));
    const { record, entries } = prepared.previous;
    assert.equal(record.savedBy, expected.previous.savedBy, where("previous saved by"));
    assert.equal(
      record.removedDecisions.length,
      expected.previous.removedDecisions,
      where("previous removed decisions")
    );
    for (const table of DECISION_TABLE_IDS) {
      assert.equal(entries[table].size, expected.previous.entries[table], where(`previous ${table}`));
    }
  }

  // Used as the previous audit of a new one, as the Audit page's Previous
  // Audit upload does: each of its decisions is there to carry.
  const asPrevious = previousAuditFromSaved(openSavedAudit(zip));
  for (const table of DECISION_TABLE_IDS) {
    for (const [keyCells, value, reason] of expected.decisions[table]) {
      const entry = asPrevious.entries[table].get(decisionKeyFromCells(keyCells));
      assert.ok(entry, where(`as previous, ${table} has no entry for ${keyCells.join(", ")}`));
      assert.equal(entry.decision?.value, value, where(`as previous, ${table} ${keyCells[0]} decision`));
      assert.equal(entry.decision?.reason, reason, where(`as previous, ${table} ${keyCells[0]} reason`));
    }
  }
}

console.log(`saved audit fixture checks: all assertions passed (${fixtures.length} fixtures)`);
