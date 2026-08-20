import "./style.css";
import {
  parseCsv,
  applyRowCorrection,
  rowContext,
  diagnoseWarning,
  type CsvWarning,
  type ParsedCsv,
} from "./parseCsv";
import { runAudit, TARGET_SCANNER } from "./audit";
import {
  runSanityChecks,
  hasBlockingIssues,
  FILE_SCHEMAS,
  type SanityCheckResult,
} from "./sanityChecks";
import { toCsv, downloadCsv, type Column } from "./csvExport";
import type {
  AddOnWithoutMriRow,
  AuditResult,
  DedupedMismatchRow,
  DedupedViolationRow,
  ScannerEventRow,
  ViolationRow,
} from "./types";
import {
  MISMATCH_RULE_EXPLANATIONS,
  VIOLATION_RULE_EXPLANATIONS,
  renderRuleExplanations,
} from "./ruleExplanations";

interface FileSlot {
  key: "dogfish" | "cams" | "redcap";
  label: string;
  accept: string;
}

const SLOTS: FileSlot[] = [
  { key: "dogfish", label: "Dogfish Events CSV", accept: ".csv" },
  { key: "cams", label: "CAMS Data CSV", accept: ".csv" },
  { key: "redcap", label: "REDCap Export CSV", accept: ".csv" },
];

const loadedFiles = new Map<FileSlot["key"], ParsedCsv>();

const app = document.getElementById("app")!;
app.innerHTML = `
  <h1>CAMRIS Billing Audit</h1>
  <p class="subtitle">Upload the three exports below to check billing events against the audit rules.</p>

  <div class="upload-grid">
    ${SLOTS.map(
      (slot) => `
      <div class="upload-slot">
        <div class="upload-row">
          <label for="file-${slot.key}">${slot.label}</label>
          <input type="file" id="file-${slot.key}" accept="${slot.accept}" />
          <span class="file-status" id="status-${slot.key}">No file selected</span>
        </div>
        <div id="sanity-${slot.key}"></div>
        <div id="warnings-${slot.key}"></div>
      </div>`
    ).join("")}
  </div>

  <button id="run-audit" disabled>Run Audit</button>

  <div id="error-banner" class="error-banner" style="display: none;"></div>

  <div id="results" class="results">
    <div class="results-section">
      <div class="results-section-header">
        <h2>Violations by Protocol <span class="count" id="deduped-violation-count"></span></h2>
        <button class="secondary" id="export-deduped-violations">Export CSV</button>
      </div>
      <div class="table-wrap" id="deduped-violations-table"></div>
      ${renderRuleExplanations(VIOLATION_RULE_EXPLANATIONS)}
    </div>

    <div class="results-section">
      <div class="results-section-header">
        <h2>Violations by Event <span class="count" id="violation-count"></span></h2>
        <button class="secondary" id="export-violations">Export CSV</button>
      </div>
      <div class="table-wrap" id="violations-table"></div>
      ${renderRuleExplanations(VIOLATION_RULE_EXPLANATIONS)}
    </div>

    <div class="results-section">
      <div class="results-section-header">
        <h2>Mismatches <span class="count" id="mismatch-count"></span></h2>
        <button class="secondary" id="export-mismatches">Export CSV</button>
      </div>
      <div class="table-wrap" id="mismatches-table"></div>
      ${renderRuleExplanations(MISMATCH_RULE_EXPLANATIONS)}
    </div>

    <div class="results-section">
      <div class="results-section-header">
        <h2>${TARGET_SCANNER} Scanner Events <span class="count" id="scanner-event-count"></span></h2>
        <button class="secondary" id="export-scanner-events">Export CSV</button>
      </div>
      <div class="table-wrap" id="scanner-events-table"></div>
      <p class="table-note">Every Dogfish row on the ${TARGET_SCANNER} scanner, including no-shows and late cancellations — not filtered by any audit rule.</p>
    </div>

    <div class="results-section">
      <div class="results-section-header">
        <h2>Add-On Fees Without MRI <span class="count" id="addon-count"></span></h2>
        <button class="secondary" id="export-addons">Export CSV</button>
      </div>
      <div class="table-wrap" id="addons-table"></div>
      <p class="table-note">Events billed for a Stimulus/Response Equipment and/or Neuroreader (Research Report Reader) fee with no MRI service code on the same event — these fees are meant to accompany a scan, so one alone is a data-quality flag independent of the CAMS/REDCap checks.</p>
    </div>
  </div>
`;

const runButton = document.getElementById("run-audit") as HTMLButtonElement;
const errorBanner = document.getElementById("error-banner")!;
const resultsEl = document.getElementById("results")!;

const loadedFilenames = new Map<FileSlot["key"], string>();

function updateRunButtonState(): void {
  const missingAFile = SLOTS.some((slot) => !loadedFiles.has(slot.key));
  const hasBlockingSanityIssue = SLOTS.some((slot) => {
    const parsed = loadedFiles.get(slot.key);
    return parsed
      ? hasBlockingIssues(runSanityChecks(FILE_SCHEMAS[slot.key], parsed))
      : false;
  });
  runButton.disabled = missingAFile || hasBlockingSanityIssue;
}

function setStatus(
  key: FileSlot["key"],
  text: string,
  cls: "" | "loaded" | "warning" = ""
): void {
  const el = document.getElementById(`status-${key}`)!;
  el.textContent = text;
  el.className = `file-status${cls ? " " + cls : ""}`;
}

/** Sets a results-section count badge, for example "(3)". */
function setCount(id: string, count: number): void {
  document.getElementById(id)!.textContent = `(${count})`;
}

/** Updates the status line and warnings box for `key` from whatever is
 * currently stored in `loadedFiles`. Call this after loading a file, and
 * again after a row correction changes the stored parse result. */
function refreshFileDisplay(key: FileSlot["key"]): void {
  const parsed = loadedFiles.get(key);
  const filename = loadedFilenames.get(key) ?? "file";
  if (!parsed) return;

  if (parsed.warnings.length > 0) {
    setStatus(
      key,
      `${filename} — ${parsed.rows.length} rows (${parsed.warnings.length} had formatting issues)`,
      "warning"
    );
  } else {
    setStatus(key, `${filename} — ${parsed.rows.length} rows`, "loaded");
  }
  renderSanityChecks(key);
  renderCsvWarnings(key);
}

/** Builds and shows the sanity-check results for `key`: missing required
 * columns block the audit and are shown first, then column-name and
 * coded-value warnings that do not block the audit. */
function renderSanityChecks(key: FileSlot["key"]): void {
  const container = document.getElementById(`sanity-${key}`)!;
  container.innerHTML = "";

  const parsed = loadedFiles.get(key);
  if (!parsed) return;

  const result = runSanityChecks(FILE_SCHEMAS[key], parsed);

  const blockingCount = result.missingColumns.length + result.renamedColumns.length;
  if (blockingCount > 0) {
    container.appendChild(buildBlockingColumnsBox(result));
  }

  const warningCount = result.unrecognizedValues.length + (result.isEmpty ? 1 : 0);
  if (warningCount > 0) {
    container.appendChild(buildSanityWarningsBox(result, warningCount));
  }
}

function buildBlockingColumnsBox(result: SanityCheckResult): HTMLElement {
  const box = document.createElement("div");
  box.className = "detail-box sanity-blocking";

  const count = result.missingColumns.length + result.renamedColumns.length;
  const title = document.createElement("p");
  title.className = "sanity-blocking-title";
  title.textContent = `Run Audit is off. This file has a problem with ${count} required column${
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
    p.textContent = `The column "${issue.column}" has a value the audit rules do not know: ${shownValue}. This value appears in ${
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

function renderCsvWarnings(key: FileSlot["key"]): void {
  const container = document.getElementById(`warnings-${key}`)!;
  container.innerHTML = "";

  const parsed = loadedFiles.get(key);
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
    details.appendChild(buildWarningEntry(key, warning));
  }

  container.appendChild(details);
}

/** Builds one malformed-row entry: a specific guess at what went wrong,
 * the raw text of the row before and after for context, an editable
 * copy of the row itself, and a button to re-parse the whole file with
 * the edit applied. */
function buildWarningEntry(
  key: FileSlot["key"],
  warning: CsvWarning
): HTMLElement {
  const parsed = loadedFiles.get(key)!;
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
      buildHighlightedRow(
        "Stray quote",
        current,
        diagnosis.highlightOffset
      )
    );
  }

  const editorLabel = document.createElement("label");
  editorLabel.className = "csv-warning-editor-label";
  editorLabel.textContent = "Malformed row — edit the raw text below to fix it";
  entry.appendChild(editorLabel);

  const textarea = document.createElement("textarea");
  textarea.className = "csv-warning-editor";
  textarea.value = current;
  textarea.rows = Math.max(2, current.split("\n").length);
  entry.appendChild(textarea);

  if (after !== undefined) {
    entry.appendChild(buildContextLine("Row after", after));
  }

  const reparseButton = document.createElement("button");
  reparseButton.className = "secondary";
  reparseButton.textContent = "Re-parse with this correction";
  reparseButton.addEventListener("click", () => {
    const corrected = applyRowCorrection(parsed, rowIndex, textarea.value);
    loadedFiles.set(key, corrected);
    refreshFileDisplay(key);
    updateRunButtonState();
  });
  entry.appendChild(reparseButton);

  return entry;
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

for (const slot of SLOTS) {
  const input = document.getElementById(
    `file-${slot.key}`
  ) as HTMLInputElement;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    errorBanner.style.display = "none";
    setStatus(slot.key, `Reading ${file.name}...`);
    loadedFiles.delete(slot.key);
    renderSanityChecks(slot.key);
    renderCsvWarnings(slot.key);

    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      loadedFiles.set(slot.key, parsed);
      loadedFilenames.set(slot.key, file.name);
      refreshFileDisplay(slot.key);
    } catch (err) {
      loadedFiles.delete(slot.key);
      renderSanityChecks(slot.key);
      setStatus(slot.key, `Failed to read ${file.name}`);
      showError(err instanceof Error ? err.message : String(err));
    }

    updateRunButtonState();
  });
}

function showError(message: string): void {
  errorBanner.textContent = message;
  errorBanner.style.display = "block";
}

const violationColumns: Column<ViolationRow>[] = [
  { header: "Event ID", get: (r) => r.eventId },
  { header: "Protocol Number", get: (r) => r.protocolNumber },
  { header: "Scan Time", get: (r) => r.scanTime },
  { header: "Industry Billed As Government", get: (r) => r.industryBilledAsGovernment },
  { header: "Government Billed As Industry", get: (r) => r.governmentBilledAsIndustry },
  { header: "Animal Billed As Human", get: (r) => r.animalBilledAsHuman },
  { header: "Human Billed As Animal", get: (r) => r.humanBilledAsAnimal },
  { header: "Stimulus Billing Missed", get: (r) => r.stimulusBillingMissed },
  { header: "Stimulus Billing Extra", get: (r) => r.stimulusBillingExtra },
  { header: "Neuroreader Billing Missed", get: (r) => r.neuroreaderBillingMissed },
  { header: "Neuroreader Billing Extra", get: (r) => r.neuroreaderBillingExtra },
  { header: "Neuroreader Billed At Stellar Chance", get: (r) => r.neuroreaderAtStellarChance },
];

const dedupedViolationColumns: Column<DedupedViolationRow>[] = [
  { header: "Protocol Number", get: (r) => r.protocolNumber },
  { header: "Industry Billed As Government", get: (r) => r.industryBilledAsGovernment },
  { header: "Government Billed As Industry", get: (r) => r.governmentBilledAsIndustry },
  { header: "Animal Billed As Human", get: (r) => r.animalBilledAsHuman },
  { header: "Human Billed As Animal", get: (r) => r.humanBilledAsAnimal },
  { header: "Stimulus Billing Missed", get: (r) => r.stimulusBillingMissed },
  { header: "Stimulus Billing Extra", get: (r) => r.stimulusBillingExtra },
  { header: "Neuroreader Billing Missed", get: (r) => r.neuroreaderBillingMissed },
  { header: "Neuroreader Billing Extra", get: (r) => r.neuroreaderBillingExtra },
  { header: "Neuroreader Billed At Stellar Chance", get: (r) => r.neuroreaderAtStellarChance },
];

const mismatchColumns: Column<DedupedMismatchRow>[] = [
  { header: "Protocol Number", get: (r) => r.protocolNumber },
  { header: "Project Title", get: (r) => r.projectTitle, wrap: true },
  { header: "No CAMS Match", get: (r) => r.noCamsMatch },
  { header: "No Active REDCap Match", get: (r) => r.noActiveRedcapMatch },
  { header: "Invalid Protocol Format", get: (r) => r.invalidProtocolFormat },
];

const scannerEventColumns: Column<ScannerEventRow>[] = [
  { header: "Event ID", get: (r) => r.eventId },
  { header: "Protocol Number", get: (r) => r.protocolNumber },
  { header: "Service", get: (r) => r.service },
  { header: "Scan Time", get: (r) => r.scanTime },
  { header: "Quantity", get: (r) => r.quantity },
  { header: "Mandatory Service", get: (r) => r.mandatoryService },
  { header: "Scheduling User", get: (r) => r.schedulingUser },
  { header: "Check-In User", get: (r) => r.checkInUser },
];

const addOnColumns: Column<AddOnWithoutMriRow>[] = [
  { header: "Event ID", get: (r) => r.eventId },
  { header: "Protocol Number", get: (r) => r.protocolNumber },
  { header: "Stimulus", get: (r) => r.stimulus },
  { header: "Neuroreader", get: (r) => r.neuroreader },
];

function renderTable<T>(
  containerId: string,
  columns: Column<T>[],
  rows: T[],
  emptyMessage: string
): void {
  const container = document.getElementById(containerId)!;
  container.innerHTML = "";

  if (rows.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = emptyMessage;
    container.appendChild(note);
    return;
  }

  // This says whether each column holds boolean values. It checks the
  // first row once, then reuses the result for every header and body
  // cell in that column.
  const isBoolColumn = columns.map(
    (col) => typeof col.get(rows[0]) === "boolean"
  );

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach((col, i) => {
    const th = document.createElement("th");
    th.textContent = col.header;
    if (isBoolColumn[i]) th.className = "bool-cell";
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    columns.forEach((col, i) => {
      const td = document.createElement("td");
      const value = col.get(row);
      const classes: string[] = [];
      if (isBoolColumn[i]) {
        td.textContent = value ? "✓" : "";
        classes.push("bool-cell");
        if (value) classes.push("bool-true");
      } else {
        td.textContent = value as string;
      }
      if (col.wrap) classes.push("wrap-cell");
      if (classes.length > 0) td.className = classes.join(" ");
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  container.appendChild(table);
}

let lastResult: AuditResult = {
  violations: [],
  dedupedViolations: [],
  mismatches: [],
  dedupedMismatches: [],
  scannerEvents: [],
  addOnsWithoutMri: [],
};

runButton.addEventListener("click", () => {
  errorBanner.style.display = "none";

  try {
    const dogfishRows = loadedFiles.get("dogfish")!.rows;
    const camsRows = loadedFiles.get("cams")!.rows;
    const redcapRows = loadedFiles.get("redcap")!.rows;

    lastResult = runAudit(dogfishRows, camsRows, redcapRows);
    const {
      violations,
      dedupedViolations,
      dedupedMismatches,
      scannerEvents,
      addOnsWithoutMri,
    } = lastResult;

    setCount("violation-count", violations.length);
    setCount("deduped-violation-count", dedupedViolations.length);
    setCount("mismatch-count", dedupedMismatches.length);
    setCount("scanner-event-count", scannerEvents.length);
    setCount("addon-count", addOnsWithoutMri.length);

    renderTable(
      "violations-table",
      violationColumns,
      violations,
      "No violations found."
    );
    renderTable(
      "deduped-violations-table",
      dedupedViolationColumns,
      dedupedViolations,
      "No violations found."
    );
    renderTable(
      "mismatches-table",
      mismatchColumns,
      dedupedMismatches,
      "No mismatches found."
    );
    renderTable(
      "scanner-events-table",
      scannerEventColumns,
      scannerEvents,
      `No events found on the ${TARGET_SCANNER} scanner.`
    );
    renderTable(
      "addons-table",
      addOnColumns,
      addOnsWithoutMri,
      "No add-on fees found without an MRI service."
    );

    resultsEl.classList.add("visible");
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    resultsEl.classList.remove("visible");
  }
});

document.getElementById("export-violations")!.addEventListener("click", () => {
  downloadCsv(
    "audit_violations.csv",
    toCsv(violationColumns, lastResult.violations)
  );
});

document
  .getElementById("export-deduped-violations")!
  .addEventListener("click", () => {
    downloadCsv(
      "audit_violations_by_protocol.csv",
      toCsv(dedupedViolationColumns, lastResult.dedupedViolations)
    );
  });

document.getElementById("export-mismatches")!.addEventListener("click", () => {
  downloadCsv(
    "audit_mismatches.csv",
    toCsv(mismatchColumns, lastResult.dedupedMismatches)
  );
});

document
  .getElementById("export-scanner-events")!
  .addEventListener("click", () => {
    downloadCsv(
      `${TARGET_SCANNER.toLowerCase()}_scanner_events.csv`,
      toCsv(scannerEventColumns, lastResult.scannerEvents)
    );
  });

document.getElementById("export-addons")!.addEventListener("click", () => {
  downloadCsv(
    "addons_without_mri.csv",
    toCsv(addOnColumns, lastResult.addOnsWithoutMri)
  );
});
