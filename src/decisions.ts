import { csvField, type Column } from "./csvExport";
import type { CsvRow } from "./parseCsv";
import type {
  DedupedMismatchRow,
  HumanMriExternalEventRow,
  ProdevConsistencyRow,
  ProtocolIssueRow,
} from "./types";

/** What the reviewers decided to do about a flagged row. */
export type DecisionValue = "Fix" | "Don't fix";

export const DECISION_VALUES: DecisionValue[] = ["Fix", "Don't fix"];

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
  /** Local date, "YYYY-MM-DD", when the decision was last confirmed. A
   * decision made or changed is confirmed on the same day. */
  confirmedOn: string;
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
  protocolIssues: (row: ProtocolIssueRow) =>
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
    confirmedOn: today,
  });
}

/** A row still needs a decision when it has none, or when it is "Don't
 * fix" with no reason. */
export function needsDecision(decision: Decision | undefined): boolean {
  return (
    decision === undefined ||
    (decision.value === "Don't fix" && decision.reason === "")
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

/** The decision columns added to a table, in order. Each `get` gives the
 * text for the CSV export; the page adds the editable cells on screen. */
export function decisionColumns<T>(
  keyFn: (row: T) => string,
  decisions: Map<string, Decision>
): Column<T>[] {
  const field =
    (pick: (d: Decision) => string) =>
    (row: T): string => {
      const decision = decisions.get(keyFn(row));
      return decision ? pick(decision) : "";
    };
  return [
    { header: "Decision", get: field((d) => d.value) },
    { header: "Reason", get: field((d) => d.reason), wrap: true },
    { header: "Decided By", get: field((d) => d.decidedBy) },
    { header: "Decided On", get: field((d) => d.decidedOn) },
    { header: "Confirmed On", get: field((d) => d.confirmedOn) },
  ];
}

/** Reads a table's decisions back from its CSV file in a saved audit.
 * A row with a blank Decision has none. Rows that share a key repeat the
 * same decision, so the first one is kept. */
export function decisionsFromCsv(
  table: DecisionTableId,
  rows: CsvRow[]
): Map<string, Decision> {
  const decisions = new Map<string, Decision>();
  const cell = (row: CsvRow, header: string) => (row[header] ?? "").trim();
  for (const row of rows) {
    const value = cell(row, "Decision");
    if (value === "") continue;
    if (!(DECISION_VALUES as string[]).includes(value)) {
      throw new Error(
        `The saved audit's ${DECISION_TABLE_LABELS[table]} table has an unknown decision, "${value}".`
      );
    }
    // Key cells are not trimmed: the key is the exact text the export
    // wrote, the same as DECISION_KEYS gives for the row on screen.
    const key = keyOf(
      ...DECISION_KEY_COLUMNS[table].map((header) => row[header] ?? "")
    );
    if (decisions.has(key)) continue;
    decisions.set(key, {
      value: value as DecisionValue,
      reason: cell(row, "Reason"),
      decidedBy: cell(row, "Decided By"),
      decidedOn: cell(row, "Decided On"),
      confirmedOn: cell(row, "Confirmed On"),
    });
  }
  return decisions;
}
