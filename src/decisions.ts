import type { Column } from "./csvExport";
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

function keyOf(...parts: (string | boolean)[]): string {
  return JSON.stringify(parts);
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
