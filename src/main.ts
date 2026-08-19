import "./style.css";
import { parseCsv, type CsvRow, type CsvWarning } from "./parseCsv";
import { runAudit, TARGET_SCANNER } from "./audit";
import { toCsv, downloadCsv, type Column } from "./csvExport";
import type {
  AddOnWithoutMriRow,
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
  filename: string;
  accept: string;
}

const SLOTS: FileSlot[] = [
  { key: "dogfish", label: "Dogfish Events CSV", filename: "", accept: ".csv" },
  { key: "cams", label: "CAMS Data CSV", filename: "", accept: ".csv" },
  { key: "redcap", label: "RedCap Export CSV", filename: "", accept: ".csv" },
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

function renderCsvWarnings(key: FileSlot["key"], warnings: CsvWarning[]): void {
  const container = document.getElementById(`warnings-${key}`)!;
  container.innerHTML = "";

  if (warnings.length === 0) return;

  const details = document.createElement("details");
  details.className = "rule-explainer csv-warnings";

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

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.header;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const col of columns) {
      const td = document.createElement("td");
      const value = col.get(row);
      if (typeof value === "boolean") {
        td.textContent = value ? "✓" : "";
        if (value) td.className = "bool-true";
      } else {
        td.textContent = value;
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  container.appendChild(table);
}

let lastViolations: ViolationRow[] = [];
let lastDedupedViolations: DedupedViolationRow[] = [];
let lastDedupedMismatches: DedupedMismatchRow[] = [];
let lastScannerEvents: ScannerEventRow[] = [];
let lastAddOns: AddOnWithoutMriRow[] = [];

runButton.addEventListener("click", () => {
  errorBanner.style.display = "none";

  try {
    const dogfishRows = loadedRows.get("dogfish")!;
    const camsRows = loadedRows.get("cams")!;
    const redcapRows = loadedRows.get("redcap")!;

    const { violations, dedupedViolations, dedupedMismatches, scannerEvents, addOnsWithoutMri } =
      runAudit(dogfishRows, camsRows, redcapRows);
    lastViolations = violations;
    lastDedupedViolations = dedupedViolations;
    lastDedupedMismatches = dedupedMismatches;
    lastScannerEvents = scannerEvents;
    lastAddOns = addOnsWithoutMri;

    document.getElementById(
      "violation-count"
    )!.textContent = `(${violations.length})`;
    document.getElementById(
      "deduped-violation-count"
    )!.textContent = `(${dedupedViolations.length})`;
    document.getElementById(
      "mismatch-count"
    )!.textContent = `(${dedupedMismatches.length})`;
    document.getElementById(
      "scanner-event-count"
    )!.textContent = `(${scannerEvents.length})`;
    document.getElementById(
      "addon-count"
    )!.textContent = `(${addOnsWithoutMri.length})`;

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
  downloadCsv("audit_violations.csv", toCsv(violationColumns, lastViolations));
});

document
  .getElementById("export-deduped-violations")!
  .addEventListener("click", () => {
    downloadCsv(
      "audit_violations_by_protocol.csv",
      toCsv(dedupedViolationColumns, lastDedupedViolations)
    );
  });

document.getElementById("export-mismatches")!.addEventListener("click", () => {
  downloadCsv(
    "audit_mismatches.csv",
    toCsv(mismatchColumns, lastDedupedMismatches)
  );
});

document
  .getElementById("export-scanner-events")!
  .addEventListener("click", () => {
    downloadCsv(
      `${TARGET_SCANNER.toLowerCase()}_scanner_events.csv`,
      toCsv(scannerEventColumns, lastScannerEvents)
    );
  });

document.getElementById("export-addons")!.addEventListener("click", () => {
  downloadCsv(
    "addons_without_mri.csv",
    toCsv(addOnColumns, lastAddOns)
  );
});
