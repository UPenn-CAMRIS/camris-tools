import "./style.css";
import { parseCsv, type CsvRow, type CsvWarning } from "./parseCsv";
import { runAudit, TARGET_SCANNER } from "./audit";
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
  { key: "redcap", label: "RedCap Export CSV", accept: ".csv" },
];

const loadedRows = new Map<FileSlot["key"], CsvRow[]>();

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
      <p class="table-note">Events billed for a Stimulus/Response Equipment and/or Neuroreader (Research Report Reader) fee with no MRI service code on the same event — these fees are meant to accompany a scan, so one alone is a data-quality flag independent of the CAMS/RedCap checks.</p>
    </div>
  </div>
`;

const runButton = document.getElementById("run-audit") as HTMLButtonElement;
const errorBanner = document.getElementById("error-banner")!;
const resultsEl = document.getElementById("results")!;

function updateRunButtonState(): void {
  runButton.disabled = SLOTS.some((slot) => !loadedRows.has(slot.key));
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

function renderCsvWarnings(key: FileSlot["key"], warnings: CsvWarning[]): void {
  const container = document.getElementById(`warnings-${key}`)!;
  container.innerHTML = "";

  if (warnings.length === 0) return;

  const details = document.createElement("details");
  details.className = "detail-box csv-warnings";

  const summary = document.createElement("summary");
  summary.textContent = `${warnings.length} row${
    warnings.length === 1 ? "" : "s"
  } had formatting issues`;
  details.appendChild(summary);

  for (const warning of warnings) {
    const entry = document.createElement("div");
    entry.className = "csv-warning-entry";

    const explanation = document.createElement("p");
    explanation.className = "csv-warning-explanation";
    explanation.textContent = `Line ${warning.rowIndex + 2} of the file: ${
      warning.explanation
    }`;
    entry.appendChild(explanation);

    const nonEmptyFields = Object.entries(warning.row ?? {}).filter(
      ([, value]) => value !== undefined && value !== ""
    );
    if (nonEmptyFields.length > 0) {
      const dl = document.createElement("dl");
      dl.className = "csv-warning-fields";
      for (const [fieldName, value] of nonEmptyFields) {
        const dt = document.createElement("dt");
        dt.textContent = fieldName;
        const dd = document.createElement("dd");
        dd.textContent = value;
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      entry.appendChild(dl);
    }

    details.appendChild(entry);
  }

  container.appendChild(details);
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
    renderCsvWarnings(slot.key, []);

    try {
      const text = await file.text();
      const { rows, warnings } = parseCsv(text);
      loadedRows.set(slot.key, rows);

      if (warnings.length > 0) {
        setStatus(
          slot.key,
          `${file.name} — ${rows.length} rows (${warnings.length} had formatting issues)`,
          "warning"
        );
      } else {
        setStatus(slot.key, `${file.name} — ${rows.length} rows`, "loaded");
      }
      renderCsvWarnings(slot.key, warnings);
    } catch (err) {
      loadedRows.delete(slot.key);
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
  { header: "No Active RedCap Match", get: (r) => r.noActiveRedcapMatch },
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
    const dogfishRows = loadedRows.get("dogfish")!;
    const camsRows = loadedRows.get("cams")!;
    const redcapRows = loadedRows.get("redcap")!;

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
