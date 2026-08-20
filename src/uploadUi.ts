import {
  applyRowCorrection,
  rowContext,
  diagnoseWarning,
  type CsvWarning,
  type ParsedCsv,
} from "./parseCsv";
import {
  runSanityChecks,
  hasBlockingIssues,
  type SanityCheckResult,
  type FileSchema,
  type TabularData,
} from "./sanityChecks";

export function setStatus(
  key: string,
  text: string,
  cls: "" | "loaded" | "warning" = ""
): void {
  const el = document.getElementById(`status-${key}`)!;
  el.textContent = text;
  el.className = `file-status${cls ? " " + cls : ""}`;
}

/** Sets a results-section count badge, for example "(3)". */
export function setCount(id: string, count: number): void {
  document.getElementById(id)!.textContent = `(${count})`;
}

const EMPTY_RESULT: SanityCheckResult = {
  missingColumns: [],
  renamedColumns: [],
  unrecognizedValues: [],
  isEmpty: false,
};

/** Builds and shows the sanity-check results for `key`: missing required
 * columns block the caller's "run" action and are shown first, then
 * column-name and coded-value warnings that do not block it. Returns
 * the result so callers can decide what else to show based on it. */
export function renderSanityChecks(
  key: string,
  data: TabularData | undefined,
  schema: FileSchema
): SanityCheckResult {
  const container = document.getElementById(`sanity-${key}`)!;
  container.innerHTML = "";

  const result = data ? runSanityChecks(schema, data) : EMPTY_RESULT;
  if (!data) return result;

  const blockingCount =
    result.missingColumns.length + result.renamedColumns.length;
  if (blockingCount > 0) {
    container.appendChild(buildBlockingColumnsBox(result));
  }

  const warningCount =
    result.unrecognizedValues.length + (result.isEmpty ? 1 : 0);
  if (warningCount > 0) {
    container.appendChild(buildSanityWarningsBox(result, warningCount));
  }

  return result;
}

function buildBlockingColumnsBox(result: SanityCheckResult): HTMLElement {
  const box = document.createElement("div");
  box.className = "detail-box sanity-blocking";

  const count = result.missingColumns.length + result.renamedColumns.length;
  const title = document.createElement("p");
  title.className = "sanity-blocking-title";
  title.textContent = `This file has a problem with ${count} required column${
    count === 1 ? "" : "s"
  }.`;
  box.appendChild(title);

  const list = document.createElement("ul");
  for (const issue of result.missingColumns) {
    const li = document.createElement("li");
    li.textContent = `Missing column: "${issue.expected}".`;
    list.appendChild(li);
  }
  for (const issue of result.renamedColumns) {
    const li = document.createElement("li");
    li.textContent = `Found "${issue.actualHeader}" instead of "${issue.expected}". Check for extra spaces or different capital letters.`;
    list.appendChild(li);
  }
  box.appendChild(list);

  return box;
}

function buildSanityWarningsBox(
  result: SanityCheckResult,
  warningCount: number
): HTMLElement {
  const details = document.createElement("details");
  details.className = "detail-box sanity-warnings";
  details.open = true;

  const summary = document.createElement("summary");
  summary.textContent = `${warningCount} sanity check warning${
    warningCount === 1 ? "" : "s"
  }`;
  details.appendChild(summary);

  for (const issue of result.unrecognizedValues) {
    const p = document.createElement("p");
    p.className = "sanity-warning-line";
    const shownValue = issue.value === "" ? "(blank)" : `"${issue.value}"`;
    p.textContent = `The column "${issue.column}" has a value the rules do not know: ${shownValue}. This value appears in ${
      issue.count
    } row${issue.count === 1 ? "" : "s"}.`;
    details.appendChild(p);
  }

  if (result.isEmpty) {
    const p = document.createElement("p");
    p.className = "sanity-warning-line";
    p.textContent = "This file has a header row, but it has no data rows.";
    details.appendChild(p);
  }

  return details;
}

/** Renders the malformed-row detail box for `key` from `parsed`, and
 * wires up its correction editors. `onCorrected` is called with the
 * re-parsed file after a user applies a correction — the caller is
 * responsible for storing it and refreshing its own display. Renders
 * nothing when `parsed` is undefined or has no warnings — this is only
 * meaningful for a file that went through `parseCsv`, since only CSV
 * parsing can lose track of a malformed row this way. */
export function renderCsvWarnings(
  key: string,
  parsed: ParsedCsv | undefined,
  onCorrected: (corrected: ParsedCsv) => void
): void {
  const container = document.getElementById(`warnings-${key}`)!;
  container.innerHTML = "";

  if (!parsed || parsed.warnings.length === 0) return;

  const details = document.createElement("details");
  details.className = "detail-box csv-warnings";
  details.open = true;

  const summary = document.createElement("summary");
  summary.textContent = `${parsed.warnings.length} row${
    parsed.warnings.length === 1 ? "" : "s"
  } had formatting issues`;
  details.appendChild(summary);

  for (const warning of parsed.warnings) {
    details.appendChild(buildWarningEntry(parsed, warning, onCorrected));
  }

  container.appendChild(details);

  // scrollHeight only reads correctly once the textarea has real layout,
  // so size each one after it is in the live document, not while it is
  // still being built.
  for (const textarea of container.querySelectorAll(".csv-warning-editor")) {
    autoGrowTextarea(textarea as HTMLTextAreaElement);
  }
}

/** Builds one malformed-row entry: a specific guess at what went wrong,
 * the raw text of the row before and after for context, an editable
 * copy of the row itself, and a button to re-parse the whole file with
 * the edit applied. */
function buildWarningEntry(
  parsed: ParsedCsv,
  warning: CsvWarning,
  onCorrected: (corrected: ParsedCsv) => void
): HTMLElement {
  const rowIndex = warning.rowIndex;
  const { before, current, after } = rowContext(parsed, rowIndex);
  const diagnosis = diagnoseWarning(parsed, warning);

  const entry = document.createElement("div");
  entry.className = "csv-warning-entry";

  const explanationEl = document.createElement("p");
  explanationEl.className = "csv-warning-explanation";
  explanationEl.textContent = `Line ${rowIndex + 2} of the file: ${
    diagnosis.message
  }`;
  entry.appendChild(explanationEl);

  if (before !== undefined) {
    entry.appendChild(buildContextLine("Row before", before));
  }

  if (diagnosis.highlightOffset !== undefined) {
    entry.appendChild(
      buildHighlightedRow("Stray quote", current, diagnosis.highlightOffset)
    );
  }

  const editorLabel = document.createElement("label");
  editorLabel.className = "csv-warning-editor-label";
  editorLabel.textContent = "Malformed row — edit the raw text below to fix it";
  entry.appendChild(editorLabel);

  const textarea = document.createElement("textarea");
  textarea.className = "csv-warning-editor";
  textarea.value = current;
  textarea.rows = 2;
  textarea.addEventListener("input", () => autoGrowTextarea(textarea));
  entry.appendChild(textarea);

  if (after !== undefined) {
    entry.appendChild(buildContextLine("Row after", after));
  }

  const reparseButton = document.createElement("button");
  reparseButton.className = "secondary";
  reparseButton.textContent = "Re-parse with this correction";
  reparseButton.addEventListener("click", () => {
    onCorrected(applyRowCorrection(parsed, rowIndex, textarea.value));
  });
  entry.appendChild(reparseButton);

  return entry;
}

/** Grows a textarea to fit its content, including lines that wrap
 * without a line break in the text. The `rows` attribute alone cannot
 * do this, since it counts line breaks, not wrapped lines. */
function autoGrowTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function buildContextLine(label: string, text: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "csv-warning-context";
  const labelEl = document.createElement("span");
  labelEl.className = "csv-warning-context-label";
  labelEl.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = text;
  wrap.appendChild(labelEl);
  wrap.appendChild(pre);
  return wrap;
}

/** Like buildContextLine, but marks the single character at `offset`
 * so the user can see exactly where PapaParse lost track of the row. */
function buildHighlightedRow(
  label: string,
  text: string,
  offset: number
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "csv-warning-context";
  const labelEl = document.createElement("span");
  labelEl.className = "csv-warning-context-label";
  labelEl.textContent = label;
  const pre = document.createElement("pre");

  const clampedOffset = Math.max(0, Math.min(offset, text.length - 1));
  pre.appendChild(document.createTextNode(text.slice(0, clampedOffset)));
  const mark = document.createElement("mark");
  mark.textContent = text.slice(clampedOffset, clampedOffset + 1) || " ";
  pre.appendChild(mark);
  pre.appendChild(document.createTextNode(text.slice(clampedOffset + 1)));

  wrap.appendChild(labelEl);
  wrap.appendChild(pre);
  return wrap;
}

export { hasBlockingIssues };
