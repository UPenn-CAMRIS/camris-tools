import { OPPOSITE_RATE_ISSUES } from "./audit";
import type { Column } from "./csvExport";
import {
  DECISION_KEYS,
  DECISION_KEY_COLUMNS,
  DECISION_TABLE_LABELS,
  decisionColumnsOf,
  decisionFromCsvRow,
  decisionKeyCellsFromCsv,
  decisionKeyFromCells,
  type Decision,
  type DecisionTableId,
} from "./decisions";
import { parseCsv, type CsvRow } from "./parseCsv";
import {
  DECISION_REPORT_FILES,
  EARLIER_DECISIONS_FILE,
  type PreviousAuditRecord,
  type RemovedDecision,
  type ScanRange,
} from "./savedAudit";
import type { ProtocolIssueRow } from "./types";

/**
 * A previous audit, used for reference when starting a new one:
 *
 * - Each row of the four decision tables gets a Since Previous Audit
 *   label that compares it with the previous audit (SINCE_PREVIOUS).
 * - A previous "Don't fix" is filled in on a row flagged again, and needs
 *   a reviewer to confirm it in this audit (carryDecisions).
 * - A previous "Fix" is never filled in; its row's label says so.
 * - A previous "Fix" on a rate check that CAMS and REDCap disagreed on
 *   comes back as the opposite rate check (findReversals). Its reason is
 *   filled in, as an unconfirmed "Don't fix", and it is not listed in
 *   the Earlier Decisions Not Flagged table.
 * - A previous decision whose row this audit does not flag is listed in
 *   the Earlier Decisions Not Flagged table (earlierDecisionRows), so a
 *   "Don't fix" keeps moving forward until a reviewer removes it.
 */

export const DECISION_TABLE_IDS = Object.keys(
  DECISION_TABLE_LABELS
) as DecisionTableId[];

/** The Since Previous Audit column's texts. A row flagged again can add
 * a note in parentheses; see flaggedAgainLabel. */
export const SINCE_PREVIOUS = {
  new: "New",
  flaggedAgain: "Flagged again",
  /** The opposite rate check of a previous "Fix"; see findReversals. */
  reversed: "Reversed",
  /** The previous audit flagged it, and this upload covers the scans it
   * was flagged on, so it would have been flagged again if still wrong. */
  resolved: "Not flagged, resolved",
  /** The previous audit flagged it on scans this upload does not cover. */
  outsideDates: "Not flagged, outside this upload's dates",
  /** The previous audit did not flag it either; its decision came from an
   * earlier audit. */
  earlier: "Not flagged, carried from an earlier audit",
} as const;

/** What the previous audit had for one decision key of one table. */
export interface PreviousEntry {
  /** The key columns' text, in the order of DECISION_KEY_COLUMNS. */
  keyCells: string[];
  /** undefined when it had no decision, or conflicting ones. */
  decision: Decision | undefined;
  /** The key's rows had different decisions. The tool never writes this;
   * only a file edited by hand can have it. Such a decision is not
   * carried. */
  conflict: boolean;
  /** The previous audit flagged it, rather than only carrying it in its
   * Earlier Decisions Not Flagged table. */
  wasFlagged: boolean;
  /** Its Disagreeing Source; "" in a table without that column. */
  source: string;
  /** The earliest and latest scan it was flagged on; null when its table
   * has no scan times (Mismatches) or it was not flagged. */
  scanSpan: ScanRange | null;
}

export interface PreviousAudit {
  record: PreviousAuditRecord;
  /** The previous audit's decision CSV files, by file name, as they were
   * read: saved with this audit so it can be opened again on its own. */
  reports: Map<string, string>;
  entries: Record<DecisionTableId, Map<string, PreviousEntry>>;
}

/** The columns that hold a table's scan times. */
const SCAN_COLUMNS: Record<DecisionTableId, string[]> = {
  protocolIssues: ["First Scan", "Last Scan"],
  mismatches: [],
  prodevConsistency: ["Scan Time"],
  humanMriExternal: ["Scan Time"],
};

function sameDecision(a: Decision, b: Decision): boolean {
  return (
    a.value === b.value &&
    a.reason === b.reason &&
    a.unconfirmed === b.unconfirmed
  );
}

function widen(span: ScanRange | null, times: string[]): ScanRange | null {
  let result = span;
  for (const time of times) {
    if (time === "") continue;
    if (!result) result = { first: time, last: time };
    else {
      if (time < result.first) result = { ...result, first: time };
      if (time > result.last) result = { ...result, last: time };
    }
  }
  return result;
}

/** Adds one CSV row of the previous audit to `entries`. */
function addEntry(
  entries: Map<string, PreviousEntry>,
  keyCells: string[],
  decision: Decision | undefined,
  wasFlagged: boolean,
  row: CsvRow,
  scanColumns: string[]
): void {
  const key = decisionKeyFromCells(keyCells);
  const times = scanColumns.map((header) => (row[header] ?? "").trim());
  const entry = entries.get(key);
  if (!entry) {
    entries.set(key, {
      keyCells,
      decision,
      conflict: false,
      wasFlagged,
      source: (row["Disagreeing Source"] ?? "").trim(),
      scanSpan: widen(null, times),
    });
    return;
  }
  // A per-event table repeats the key on each of its events.
  entry.scanSpan = widen(entry.scanSpan, times);
  const agrees =
    entry.decision === undefined
      ? decision === undefined
      : decision !== undefined && sameDecision(entry.decision, decision);
  if (!agrees && !entry.conflict) {
    entry.conflict = true;
    entry.decision = undefined;
  }
}

/** Reads a previous audit from its CSV files, by file name. The four
 * decision tables' files must be there; the earlier decisions' file is
 * missing from a version-1 file. */
export function readPreviousAudit(
  record: PreviousAuditRecord,
  reports: Map<string, string>
): PreviousAudit {
  const entries = {} as PreviousAudit["entries"];
  const kept = new Map<string, string>();

  for (const table of DECISION_TABLE_IDS) {
    const file = DECISION_REPORT_FILES[table];
    const csv = reports.get(file);
    if (csv === undefined) {
      throw new Error(`The previous audit is missing ${file}.`);
    }
    kept.set(file, csv);
    entries[table] = new Map();
    for (const row of parseCsv(csv).rows) {
      addEntry(
        entries[table],
        decisionKeyCellsFromCsv(table, row),
        decisionFromCsvRow(row, `previous audit's ${DECISION_TABLE_LABELS[table]}`),
        true,
        row,
        SCAN_COLUMNS[table]
      );
    }
  }

  const earlierCsv = reports.get(EARLIER_DECISIONS_FILE);
  if (earlierCsv !== undefined) {
    kept.set(EARLIER_DECISIONS_FILE, earlierCsv);
    for (const row of parseCsv(earlierCsv).rows) {
      const table = tableFromLabel(row["Table"] ?? "");
      const keyCells = keyCellsFromDetails(
        table,
        row["Protocol Number"] ?? "",
        row["Details"] ?? ""
      );
      // A key the previous audit flagged is already there.
      if (entries[table].has(decisionKeyFromCells(keyCells))) continue;
      addEntry(
        entries[table],
        keyCells,
        decisionFromCsvRow(row, "previous audit's Earlier Decisions Not Flagged"),
        false,
        row,
        []
      );
    }
  }

  return { record, reports: kept, entries };
}

function tableFromLabel(label: string): DecisionTableId {
  const table = DECISION_TABLE_IDS.find(
    (id) => DECISION_TABLE_LABELS[id] === label.trim()
  );
  if (!table) {
    throw new Error(
      `The previous audit's Earlier Decisions Not Flagged table names an unknown table, "${label}".`
    );
  }
  return table;
}

/** The Details column of the Earlier Decisions Not Flagged table: the key
 * columns after Protocol Number, in words. The issue, for Violations by
 * Protocol; the names of the checks that are TRUE, for Mismatches and
 * Prodev Naming Consistency; nothing, for Human MRI (Industry/External)
 * Events. keyCellsFromDetails reverses it. */
export function detailsFromKeyCells(
  table: DecisionTableId,
  keyCells: string[]
): string {
  if (table === "protocolIssues") return keyCells[1];
  if (table === "humanMriExternal") return "";
  return DECISION_KEY_COLUMNS[table]
    .slice(1)
    .filter((_, i) => keyCells[i + 1] === "TRUE")
    .join("; ");
}

export function keyCellsFromDetails(
  table: DecisionTableId,
  protocolNumber: string,
  details: string
): string[] {
  if (table === "protocolIssues") return [protocolNumber, details];
  if (table === "humanMriExternal") return [protocolNumber];
  const checks = DECISION_KEY_COLUMNS[table].slice(1);
  const named = details
    .split(";")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  for (const name of named) {
    if (!checks.includes(name)) {
      throw new Error(
        `The previous audit's Earlier Decisions Not Flagged table has an unknown ${DECISION_TABLE_LABELS[table]} detail, "${name}".`
      );
    }
  }
  return [
    protocolNumber,
    ...checks.map((check) => (named.includes(check) ? "TRUE" : "FALSE")),
  ];
}

/** A Violations by Protocol row of this audit that reverses a previous
 * "Fix"; see findReversals. */
export interface Reversal {
  /** The previous audit's decision key of the opposite issue. */
  previousKey: string;
  /** The opposite issue, as the previous audit flagged it. */
  issue: string;
  /** The previous audit's entry for that key. Its decision is "Fix". */
  entry: PreviousEntry;
}

const OTHER_INDUSTRY_SOURCE: Record<string, string> = {
  CAMS: "REDCap",
  REDCap: "CAMS",
};

/** The Violations by Protocol rows that reverse a previous "Fix", by
 * decision key. CAMS and REDCap disagreed on whether the protocol is
 * industry-sponsored, so the previous audit flagged a rate check with
 * one of them as its Disagreeing Source. A reviewer marked it Fix, and
 * the rate was changed to agree with that source. Now the other source
 * disagrees, and this audit flags the opposite rate check: for example,
 * "Government billed as industry (MRI)" from REDCap becomes "Industry
 * billed as government (MRI)" from CAMS. Such a row is not new.
 *
 * A row whose own key the previous audit had is compared with that
 * entry instead, and is never a reversal. */
export function findReversals(
  rows: ProtocolIssueRow[],
  entries: Map<string, PreviousEntry>
): Map<string, Reversal> {
  const reversals = new Map<string, Reversal>();
  for (const row of rows) {
    const key = DECISION_KEYS.protocolIssues(row);
    if (entries.has(key)) continue;
    const issue = OPPOSITE_RATE_ISSUES.get(row.issue);
    const otherSource = OTHER_INDUSTRY_SOURCE[row.source];
    if (issue === undefined || otherSource === undefined) continue;
    const previousKey = decisionKeyFromCells([row.protocolNumber, issue]);
    const entry = entries.get(previousKey);
    if (
      entry?.wasFlagged &&
      entry.source === otherSource &&
      entry.decision?.value === "Fix"
    ) {
      reversals.set(key, { previousKey, issue, entry });
    }
  }
  return reversals;
}

/** The Since Previous Audit label of a row flagged in this audit, whose
 * previous entry is `entry`, and whose Disagreeing Source is `source`
 * (undefined in a table without one). `reversal` is the previous "Fix"
 * the row reverses, if any; it is used only when there is no `entry`. */
export function flaggedAgainLabel(
  entry: PreviousEntry | undefined,
  source: string | undefined,
  reversal?: Reversal
): string {
  if (!entry && reversal) {
    return `${SINCE_PREVIOUS.reversed} (was ${reversal.issue} from ${reversal.entry.source}, marked Fix on ${reversal.entry.decision!.decidedOn})`;
  }
  if (!entry) return SINCE_PREVIOUS.new;
  let label: string = SINCE_PREVIOUS.flaggedAgain;
  if (source !== undefined && entry.source !== "" && entry.source !== source) {
    label += `, source changed (was ${entry.source})`;
  }
  if (entry.conflict) {
    label += " (the previous audit had conflicting decisions)";
  } else if (entry.decision?.value === "Fix") {
    label += ` (marked Fix on ${entry.decision.decidedOn})`;
  }
  return label;
}

/** The Since Previous Audit label of each decision key flagged in this
 * audit. `reversals`, from findReversals, is for Violations by
 * Protocol. */
export function sincePreviousLabels<T>(
  table: DecisionTableId,
  rows: T[],
  keyFn: (row: T) => string,
  sourceOf: ((row: T) => string) | undefined,
  previous: PreviousAudit | null,
  reversals?: Map<string, Reversal>
): Map<string, string> {
  const labels = new Map<string, string>();
  if (!previous) return labels;
  for (const row of rows) {
    const key = keyFn(row);
    if (labels.has(key)) continue;
    labels.set(
      key,
      flaggedAgainLabel(
        previous.entries[table].get(key),
        sourceOf?.(row),
        reversals?.get(key)
      )
    );
  }
  return labels;
}

/** Fills in each previous "Don't fix" on a key flagged in this audit, as
 * unconfirmed: it counts as needing a decision until a reviewer confirms
 * it. A key is considered once, so a decision a reviewer removed is not
 * filled in again when the audit re-runs; a key that already has a
 * decision keeps it.
 *
 * A key in `reversals` (from findReversals) gets an unconfirmed "Don't
 * fix" with the reason, Decided By, and Decided On of the "Fix" it
 * reverses: the rate was changed for that reason, so the opposite flag
 * is expected. */
export function carryDecisions(
  keys: Iterable<string>,
  entries: Map<string, PreviousEntry>,
  decisions: Map<string, Decision>,
  considered: Set<string>,
  reversals?: Map<string, Reversal>
): void {
  for (const key of keys) {
    if (considered.has(key)) continue;
    considered.add(key);
    if (decisions.has(key)) continue;
    const own = entries.get(key)?.decision;
    const previous =
      own?.value === "Don't fix" ? own : reversals?.get(key)?.entry.decision;
    if (!previous) continue;
    decisions.set(key, {
      value: "Don't fix",
      reason: previous.reason,
      decidedBy: previous.decidedBy,
      decidedOn: previous.decidedOn,
      confirmedBy: "",
      confirmedOn: "",
      unconfirmed: true,
    });
  }
}

/** A row of the Earlier Decisions Not Flagged table. */
export interface EarlierDecisionRow {
  table: DecisionTableId;
  key: string;
  keyCells: string[];
  sincePrevious: string;
  decision: Decision;
}

/** An identity for a removed earlier decision, unique across tables. */
export function removedId(table: DecisionTableId, keyCells: string[]): string {
  return JSON.stringify([table, decisionKeyFromCells(keyCells)]);
}

export function removedIds(removed: RemovedDecision[]): Set<string> {
  return new Set(removed.map((r) => removedId(r.table, r.keyCells)));
}

/** True when `range` covers every scan in `span`. */
function covers(range: ScanRange | null, span: ScanRange | null): boolean {
  return (
    range !== null &&
    span !== null &&
    range.first <= span.first &&
    span.last <= range.last
  );
}

/** The previous decisions whose keys this audit does not flag, and that
 * are still worth listing:
 *
 * - every "Don't fix", so it keeps moving forward, unless a reviewer
 *   removed it (`removed`, from removedIds);
 * - a "Fix" the previous audit flagged on scans this upload covers,
 *   once, as resolved.
 *
 * A previous "Fix" whose scans this upload does not cover is dropped: it
 * is in the previous audit's file. So is a "Fix" that a Violations by
 * Protocol row of this audit reverses (`reversals`, from findReversals):
 * that row shows it. `flagged` holds each table's keys flagged in this
 * audit, and `range` is this upload's Dogfish scan range.
 */
export function earlierDecisionRows(
  previous: PreviousAudit | null,
  flagged: Record<DecisionTableId, Set<string>>,
  range: ScanRange | null,
  removed: Set<string>,
  reversals?: Map<string, Reversal>
): EarlierDecisionRow[] {
  const rows: EarlierDecisionRow[] = [];
  if (!previous) return rows;
  const reversed = new Set(
    [...(reversals?.values() ?? [])].map((r) => r.previousKey)
  );
  for (const table of DECISION_TABLE_IDS) {
    for (const [key, entry] of previous.entries[table]) {
      const decision = entry.decision;
      if (!decision || flagged[table].has(key)) continue;
      if (table === "protocolIssues" && reversed.has(key)) continue;
      if (removed.has(removedId(table, entry.keyCells))) continue;

      let sincePrevious: string;
      if (!entry.wasFlagged) {
        if (decision.value !== "Don't fix") continue;
        sincePrevious = SINCE_PREVIOUS.earlier;
      } else {
        const resolved = covers(
          range,
          entry.scanSpan ?? previous.record.dogfishScanRange
        );
        if (decision.value === "Fix" && !resolved) continue;
        sincePrevious = resolved ? SINCE_PREVIOUS.resolved : SINCE_PREVIOUS.outsideDates;
      }
      rows.push({ table, key, keyCells: entry.keyCells, sincePrevious, decision });
    }
  }
  return rows;
}

/** The Earlier Decisions Not Flagged table's columns, for the screen and
 * the CSV. Table, Protocol Number, and Details identify the decision's
 * key; readPreviousAudit reads them back. */
export function earlierDecisionColumns(): Column<EarlierDecisionRow>[] {
  return [
    { header: "Table", get: (r) => DECISION_TABLE_LABELS[r.table] },
    { header: "Protocol Number", get: (r) => r.keyCells[0] },
    {
      header: "Details",
      get: (r) => detailsFromKeyCells(r.table, r.keyCells),
      wrap: true,
    },
    { header: "Since Previous Audit", get: (r) => r.sincePrevious },
    ...decisionColumnsOf((r: EarlierDecisionRow) => r.decision),
  ];
}
