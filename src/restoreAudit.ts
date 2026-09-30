import {
  applyRowCorrections,
  decodeCsvBytes,
  parseCsv,
  type ParsedCsv,
} from "./parseCsv";
import {
  decisionKeyCellsFromCsv,
  decisionKeyFromCells,
  decisionsFromCsv,
  emptyDecisionStore,
  type DecisionStore,
  type DecisionTableId,
} from "./decisions";
import {
  DECISION_TABLE_IDS,
  readPreviousAudit,
  type PreviousAudit,
} from "./previousAudit";
import {
  AUDIT_INPUT_KEYS,
  DECISION_REPORT_FILES,
  openSavedAudit,
  type AuditInputKey,
  type AuditManifest,
  type OpenedAudit,
} from "./savedAudit";

/**
 * Restoring a saved audit zip, as the Audit page does when one is opened
 * or used as the previous audit. Kept apart from the page so that the
 * saved-audit fixture tests run the same code.
 */

/** A saved audit, read and checked before any of it is put on the page,
 * so a file that fails part-way leaves the page as it was. */
export interface PreparedSavedAudit {
  manifest: AuditManifest;
  inputs: Record<
    AuditInputKey,
    { filename: string; bytes: Uint8Array; parsed: ParsedCsv }
  >;
  decisions: DecisionStore;
  /** Every decision key listed in the four decision tables' files, with a
   * decision or not: a previous audit's decisions are not filled in on
   * these again. */
  considered: Record<DecisionTableId, Set<string>>;
  /** The previous audit the saved audit was started with, if any. */
  previous: PreviousAudit | null;
}

/** An empty set of keys for each decision table. */
export function emptyKeySets(): Record<DecisionTableId, Set<string>> {
  return {
    protocolIssues: new Set(),
    mismatches: new Set(),
    prodevConsistency: new Set(),
    humanMriExternal: new Set(),
  };
}

/** A saved audit as the previous audit of a new one. Its own previous
 * audit, and the decisions removed in it, do not carry over: its CSV
 * files already hold what it passed on. */
export function previousAuditFromSaved(opened: OpenedAudit): PreviousAudit {
  const { manifest } = opened;
  return readPreviousAudit(
    {
      auditId: manifest.auditId,
      savedAt: manifest.savedAt,
      savedBy: manifest.savedBy,
      dogfishScanRange: manifest.dogfishScanRange,
      removedDecisions: [],
    },
    opened.reports
  );
}

/** Reads a saved audit zip to open it: its inputs with their row
 * corrections applied again, its decisions, and its previous audit. */
export function prepareSavedAudit(zip: Uint8Array): PreparedSavedAudit {
  const opened = openSavedAudit(zip);

  const inputs = {} as PreparedSavedAudit["inputs"];
  for (const key of AUDIT_INPUT_KEYS) {
    const { filename, bytes, corrections } = opened.inputs[key];
    let parsed: ParsedCsv;
    try {
      parsed = applyRowCorrections(parseCsv(decodeCsvBytes(bytes)), corrections);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`The saved audit's ${filename} could not be restored. ${why}`);
    }
    inputs[key] = { filename, bytes, parsed };
  }

  const decisions = emptyDecisionStore();
  const considered = emptyKeySets();
  for (const table of DECISION_TABLE_IDS) {
    const reportFile = DECISION_REPORT_FILES[table];
    const csv = opened.reports.get(reportFile);
    if (csv === undefined) {
      throw new Error(`This saved audit is missing reports/${reportFile}.`);
    }
    const rows = parseCsv(csv).rows;
    decisions[table] = decisionsFromCsv(table, rows);
    for (const row of rows) {
      considered[table].add(decisionKeyFromCells(decisionKeyCellsFromCsv(table, row)));
    }
  }

  const previous = opened.previous
    ? readPreviousAudit(opened.previous.record, opened.previous.reports)
    : null;

  return { manifest: opened.manifest, inputs, decisions, considered, previous };
}
