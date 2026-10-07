import { csvField, type Column } from "./csvExport";
import type { CsvRow } from "./parseCsv";
import type {
  DedupedMismatchRow,
  HumanMriExternalEventRow,
  ProdevConsistencyRow,
  ProtocolIssueRow,
  ViolationIssueRow,
} from "./types";

/** What the reviewers decided to do about a flagged row. */
export type DecisionValue = "Fix" | "Don't fix";

export const DECISION_VALUES: DecisionValue[] = ["Fix", "Don't fix"];

/** The Decision column's text for a "Don't fix" carried from a previous
 * audit that no one has confirmed in this audit yet. */
export const UNCONFIRMED_DONT_FIX = "Don't fix (unconfirmed)";

/** One decision, for one decision key of one table. */
export interface Decision {
  value: DecisionValue;
  /** Why. Required for "Don't fix", optional for "Fix". */
  reason: string;
  /** The reviewer's initials. */
  decidedBy: string;
  /** Local date, "YYYY-MM-DD", when the decision was last made or
   * changed. */
  decidedOn: string;
  /** The initials of the reviewer who last confirmed the decision. A
   * decision made or changed is confirmed by the same reviewer. */
  confirmedBy: string;
  /** Local date, "YYYY-MM-DD", when the decision was last confirmed. A
   * decision made or changed is confirmed on the same day. */
  confirmedOn: string;
  /** True for a "Don't fix" carried from a previous audit and not yet
   * confirmed in this one. Its Confirmed By and Confirmed On are blank. */
  unconfirmed?: boolean;
}

/** The results tables that take decisions. */
export type DecisionTableId =
  | "protocolIssues"
  | "mismatches"
  | "prodevConsistency"
  | "humanMriExternal";

/** Each table's heading on the audit page. */
export const DECISION_TABLE_LABELS: Record<DecisionTableId, string> = {
  protocolIssues: "Violations by Protocol",
  mismatches: "Mismatches",
  prodevConsistency: "Prodev Naming Consistency",
  humanMriExternal: "Human MRI (Industry/External) Events",
};

/** The decisions for each table, by decision key. */
export type DecisionStore = Record<DecisionTableId, Map<string, Decision>>;

export function emptyDecisionStore(): DecisionStore {
  return {
    protocolIssues: new Map(),
    mismatches: new Map(),
    prodevConsistency: new Map(),
    humanMriExternal: new Map(),
  };
}

/** A decision key: the key columns' values, as the CSV export writes
 * them, so a row on screen and the same row read back from a saved
 * audit's CSV give the same key. */
function keyOf(...parts: (string | boolean)[]): string {
  return JSON.stringify(parts.map(csvField));
}

/** The decision key for a row's key columns' text, in the order of
 * DECISION_KEY_COLUMNS. */
export function decisionKeyFromCells(cells: string[]): string {
  return keyOf(...cells);
}

/** The decision key of each table's rows. A decision belongs to its key,
 * not to one row: every row with the same key shows the same decision,
 * and a later audit's rows with that key match it.
 *
 * - Violations by Protocol: the protocol number and the issue.
 * - Mismatches: the protocol number and the set of checks that failed,
 *   so a protocol whose failed checks change needs a new decision.
 * - Prodev Naming Consistency: the protocol number and the direction of
 *   the mismatch. The table has one row per event; the decision covers
 *   every event of that protocol in that direction.
 * - Human MRI (Industry/External) Events: the protocol number. The
 *   decision covers every external-rate event of that protocol. */
export const DECISION_KEYS = {
  protocolIssues: (row: Pick<ProtocolIssueRow, "protocolNumber" | "issue">) =>
    keyOf(row.protocolNumber, row.issue),
  mismatches: (row: DedupedMismatchRow) =>
    keyOf(
      row.protocolNumber,
      row.noCamsMatch,
      row.noActiveRedcapMatch,
      row.noRedcapFundingType,
      row.invalidProtocolFormat
    ),
  prodevConsistency: (row: ProdevConsistencyRow) =>
    keyOf(
      row.protocolNumber,
      row.prodevServiceWithoutSuffix,
      row.suffixWithoutProdevService
    ),
  humanMriExternal: (row: HumanMriExternalEventRow) =>
    keyOf(row.protocolNumber),
} satisfies Record<DecisionTableId, (row: never) => string>;

/** The CSV columns that hold each table's decision key, in the order
 * DECISION_KEYS uses them. They must match the table's column headers
 * on the audit page. */
export const DECISION_KEY_COLUMNS: Record<DecisionTableId, string[]> = {
  protocolIssues: ["Protocol Number", "Issue"],
  mismatches: [
    "Protocol Number",
    "No CAMS Match",
    "No Active REDCap Match",
    "No REDCap Funding Type",
    "Invalid Protocol Format",
  ],
  prodevConsistency: [
    "Protocol Number",
    "Prodev Service Without Suffix",
    "Suffix Without Prodev Service",
  ],
  humanMriExternal: ["Protocol Number"],
};

/** Records a decision made today, or removes it when `value` is "". The
 * decision is dated and confirmed today, by `reviewer`. */
export function recordDecision(
  decisions: Map<string, Decision>,
  key: string,
  value: DecisionValue | "",
  reason: string,
  reviewer: string,
  today: string
): void {
  if (value === "") {
    decisions.delete(key);
    return;
  }
  decisions.set(key, {
    value,
    reason: reason.trim(),
    decidedBy: reviewer.trim(),
    decidedOn: today,
    confirmedBy: reviewer.trim(),
    confirmedOn: today,
  });
}

/** Confirms a decision carried from a previous audit: `reviewer` confirms
 * it today, and its value, reason, and Decided By/On stay as they were. */
export function confirmDecision(
  decisions: Map<string, Decision>,
  key: string,
  reviewer: string,
  today: string
): void {
  const decision = decisions.get(key);
  if (!decision) return;
  decisions.set(key, {
    value: decision.value,
    reason: decision.reason,
    decidedBy: decision.decidedBy,
    decidedOn: decision.decidedOn,
    confirmedBy: reviewer.trim(),
    confirmedOn: today,
  });
}

/** A row still needs a decision when it has none, when its decision is
 * carried from a previous audit and not confirmed yet, or when it is
 * "Don't fix" with no reason. */
export function needsDecision(decision: Decision | undefined): boolean {
  return (
    decision === undefined ||
    decision.unconfirmed === true ||
    (decision.value === "Don't fix" && decision.reason === "")
  );
}

/** The Event IDs of the Violations by Event table whose every violation
 * is "Don't fix" on Violations by Protocol, by `decisions` (that table's
 * decisions). A violation's decision is the one on its protocol number
 * and issue. A "Don't fix" that still needs a decision (carried and not
 * confirmed, or with no reason) does not count. */
export function eventsAllDontFix(
  rows: ViolationIssueRow[],
  decisions: Map<string, Decision>
): Set<string> {
  const allDontFix = new Map<string, boolean>();
  for (const row of rows) {
    const decision = decisions.get(DECISION_KEYS.protocolIssues(row));
    const dontFix = decision?.value === "Don't fix" && !needsDecision(decision);
    allDontFix.set(row.eventId, (allDontFix.get(row.eventId) ?? true) && dontFix);
  }
  return new Set(
    [...allDontFix].filter(([, all]) => all).map(([eventId]) => eventId)
  );
}

/** How many of `rows` still need a decision. */
export function countNeedingDecision<T>(
  rows: T[],
  keyFn: (row: T) => string,
  decisions: Map<string, Decision>
): number {
  return rows.filter((row) => needsDecision(decisions.get(keyFn(row))))
    .length;
}

/** The Decision column's text for `decision`. */
export function decisionText(decision: Decision): string {
  return decision.unconfirmed ? UNCONFIRMED_DONT_FIX : decision.value;
}

/** The decision columns added to a table, in order, reading each row's
 * decision with `decisionOf`. Each `get` gives the text for the CSV
 * export; the page adds the editable cells on screen. */
export function decisionColumnsOf<T>(
  decisionOf: (row: T) => Decision | undefined
): Column<T>[] {
  const field =
    (pick: (d: Decision) => string) =>
    (row: T): string => {
      const decision = decisionOf(row);
      return decision ? pick(decision) : "";
    };
  return [
    { header: "Decision", get: field(decisionText) },
    { header: "Reason", get: field((d) => d.reason), wrap: true },
    { header: "Decided By", get: field((d) => d.decidedBy) },
    { header: "Decided On", get: field((d) => d.decidedOn) },
    { header: "Confirmed By", get: field((d) => d.confirmedBy) },
    { header: "Confirmed On", get: field((d) => d.confirmedOn) },
  ];
}

/** The decision columns for a table whose rows' decisions are in
 * `decisions`, by key. */
export function decisionColumns<T>(
  keyFn: (row: T) => string,
  decisions: Map<string, Decision>
): Column<T>[] {
  return decisionColumnsOf((row: T) => decisions.get(keyFn(row)));
}

/** A row's key columns' text in a table's CSV file, in the order of
 * DECISION_KEY_COLUMNS. Not trimmed: the key is the exact text the export
 * wrote, the same as DECISION_KEYS gives for the row on screen. */
export function decisionKeyCellsFromCsv(
  table: DecisionTableId,
  row: CsvRow
): string[] {
  return DECISION_KEY_COLUMNS[table].map((header) => row[header] ?? "");
}

/** Reads the decision columns of one CSV row. `where` names the table, for
 * the error message. A blank Decision is no decision. Files saved before
 * the Confirmed By column existed get the decider as the confirmer, since
 * a decision was then always confirmed by whoever made it. */
export function decisionFromCsvRow(
  row: CsvRow,
  where: string
): Decision | undefined {
  const cell = (header: string) => (row[header] ?? "").trim();
  const text = cell("Decision");
  if (text === "") return undefined;
  const unconfirmed = text === UNCONFIRMED_DONT_FIX;
  const value = unconfirmed ? "Don't fix" : text;
  if (!(DECISION_VALUES as string[]).includes(value)) {
    throw new Error(
      `The saved audit's ${where} table has an unknown decision, "${text}".`
    );
  }
  const decision: Decision = {
    value: value as DecisionValue,
    reason: cell("Reason"),
    decidedBy: cell("Decided By"),
    decidedOn: cell("Decided On"),
    confirmedBy: "Confirmed By" in row ? cell("Confirmed By") : cell("Decided By"),
    confirmedOn: cell("Confirmed On"),
  };
  if (unconfirmed) decision.unconfirmed = true;
  return decision;
}

/** Reads a table's decisions back from its CSV file in a saved audit.
 * A row with a blank Decision has none. Rows that share a key repeat the
 * same decision, so the first one is kept. */
export function decisionsFromCsv(
  table: DecisionTableId,
  rows: CsvRow[]
): Map<string, Decision> {
  const decisions = new Map<string, Decision>();
  for (const row of rows) {
    const decision = decisionFromCsvRow(row, DECISION_TABLE_LABELS[table]);
    if (!decision) continue;
    const key = keyOf(...decisionKeyCellsFromCsv(table, row));
    if (!decisions.has(key)) decisions.set(key, decision);
  }
  return decisions;
}
