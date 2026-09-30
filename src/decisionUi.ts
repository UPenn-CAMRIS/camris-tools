import type { Column } from "./csvExport";
import {
  DECISION_VALUES,
  confirmDecision,
  decisionColumns,
  recordDecision,
  type Decision,
  type DecisionValue,
} from "./decisions";

export interface DecisionContext {
  /** The reviewer's initials. Decisions cannot be made while blank. */
  reviewer(): string;
  /** Today's local date, "YYYY-MM-DD". */
  today(): string;
  /** Called after any decision changes. */
  onChange(): void;
}

export interface DecisionTableUi<T> {
  /** The decision columns, with editable cells on screen. */
  columns: Column<T>[];
  /** Forgets the cells of the last render. Call before each render of
   * the table. */
  reset(): void;
  /** Redraws every decision cell, for example after the reviewer's
   * initials change. */
  refreshAll(): void;
}

const NO_REVIEWER_HINT = "Enter your initials above to record decisions.";

/** The editable decision columns for one table. Rows that share a
 * decision key share one decision, so a change on one row redraws the
 * decision cells of every row with that key. */
export function decisionTableUi<T>(
  keyFn: (row: T) => string,
  decisions: Map<string, Decision>,
  context: DecisionContext
): DecisionTableUi<T> {
  let refreshers = new Map<string, (() => void)[]>();

  function register(key: string, refresh: () => void): void {
    refresh();
    const list = refreshers.get(key);
    if (list) list.push(refresh);
    else refreshers.set(key, [refresh]);
  }

  function changed(key: string): void {
    for (const refresh of refreshers.get(key) ?? []) refresh();
    context.onChange();
  }

  const noReviewer = () => context.reviewer().trim() === "";

  const [decisionCol, reasonCol, ...otherCols] = decisionColumns(
    keyFn,
    decisions
  );

  decisionCol.render = (row) => {
    const key = keyFn(row);
    const select = document.createElement("select");
    select.className = "decision-select";
    for (const value of ["", ...DECISION_VALUES]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value || "—";
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      recordDecision(
        decisions,
        key,
        select.value as DecisionValue | "",
        decisions.get(key)?.reason ?? "",
        context.reviewer(),
        context.today()
      );
      changed(key);
    });
    register(key, () => {
      const decision = decisions.get(key);
      select.value = decision?.value ?? "";
      select.disabled = noReviewer();
      select.title = select.disabled ? NO_REVIEWER_HINT : "";
      select.classList.toggle("unconfirmed", decision?.unconfirmed === true);
    });
    return select;
  };

  reasonCol.render = (row) => {
    const key = keyFn(row);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "decision-reason";
    input.addEventListener("change", () => {
      const decision = decisions.get(key);
      if (!decision) return;
      recordDecision(
        decisions,
        key,
        decision.value,
        input.value,
        context.reviewer(),
        context.today()
      );
      changed(key);
    });
    register(key, () => {
      const decision = decisions.get(key);
      input.value = decision?.reason ?? "";
      input.disabled = !decision || noReviewer();
      input.placeholder =
        decision?.value === "Don't fix"
          ? "Reason (required)"
          : decision
            ? "Reason (optional)"
            : "";
      input.classList.toggle(
        "needs-reason",
        decision?.value === "Don't fix" && decision.reason === ""
      );
    });
    return input;
  };

  for (const col of otherCols) {
    col.render = (row) => {
      const key = keyFn(row);
      const cell = document.createElement("span");
      // A decision carried from a previous audit waits for a reviewer:
      // its Confirmed On cell holds the Confirm button until then.
      const confirmButton =
        col.header === "Confirmed On" ? document.createElement("button") : null;
      if (confirmButton) {
        confirmButton.type = "button";
        confirmButton.className = "secondary decision-confirm";
        confirmButton.textContent = "Confirm";
        confirmButton.addEventListener("click", () => {
          confirmDecision(decisions, key, context.reviewer(), context.today());
          changed(key);
        });
      }
      register(key, () => {
        if (confirmButton && decisions.get(key)?.unconfirmed) {
          confirmButton.disabled = noReviewer();
          confirmButton.title = confirmButton.disabled ? NO_REVIEWER_HINT : "";
          cell.replaceChildren(confirmButton);
        } else {
          cell.textContent = col.get(row) as string;
        }
      });
      return cell;
    };
  }

  return {
    columns: [decisionCol, reasonCol, ...otherCols],
    reset: () => {
      refreshers = new Map();
    },
    refreshAll: () => {
      for (const list of refreshers.values()) {
        for (const refresh of list) refresh();
      }
    },
  };
}
