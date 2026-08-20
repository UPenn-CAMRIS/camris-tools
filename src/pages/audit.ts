import { parseCsv, type ParsedCsv } from "../parseCsv";
import { runAudit, TARGET_SCANNER } from "../audit";
import {
  runSanityChecks,
  hasBlockingIssues,
  FILE_SCHEMAS,
} from "../sanityChecks";
import { toCsv, downloadCsv, type Column } from "../csvExport";
import type {
  AddOnWithoutMriRow,
  AuditResult,
  DedupedMismatchRow,
  DedupedViolationRow,
  ScannerEventRow,
  ViolationRow,
} from "../types";
import {
  MISMATCH_RULE_EXPLANATIONS,
  VIOLATION_RULE_EXPLANATIONS,
  renderRuleExplanations,
} from "../ruleExplanations";
import { setStatus, setCount, renderSanityChecks, renderCsvWarnings } from "../uploadUi";
import { renderTable } from "../table";
import { renderPageNav } from "../nav";

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

export function renderAuditPage(app: HTMLElement): void {
  const loadedFiles = new Map<FileSlot["key"], ParsedCsv>();
  const loadedFilenames = new Map<FileSlot["key"], string>();

  app.innerHTML = `
    ${renderPageNav("audit")}
    <h1>CAMRIS Billing Audit</h1>
    <p class="subtitle">Upload the three exports below to check billing events against the audit rules.</p>

    <div class="upload-grid">
      ${SLOTS.map(
        (slot) => `
        <div class="upload-slot">
          <div class="upload-row">
            <label for="file-${slot.key}">${slot.label}</label>
            <input type="file" id="file-${slot.key}" accept="${slot.accept}" />
            <span class="file-status" id="status-${slot.key}"></span>
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

    const sanityResult = renderSanityChecks(key, parsed, FILE_SCHEMAS[key]);

    // A wrong or badly-renamed column means the whole file is probably
    // the wrong upload. In that case, row-level formatting issues are a
    // distraction — hide them so the column error stands out.
    const csvWarningsContainer = document.getElementById(`warnings-${key}`)!;
    csvWarningsContainer.innerHTML = "";
    if (!hasBlockingIssues(sanityResult)) {
      renderCsvWarnings(key, parsed, (corrected) => {
        loadedFiles.set(key, corrected);
        refreshFileDisplay(key);
        updateRunButtonState();
      });
    }
  }

  for (const slot of SLOTS) {
    const input = document.getElementById(
      `file-${slot.key}`
    ) as HTMLInputElement;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;

      // Clear the input right away. Without this, picking the same file
      // again would not fire a change event at all in some browsers,
      // since the input's value has not changed — leaving any earlier
      // in-memory row correction silently in place instead of a fresh
      // parse of the file as chosen.
      input.value = "";

      errorBanner.style.display = "none";
      setStatus(slot.key, `Reading ${file.name}...`);
      loadedFiles.delete(slot.key);
      renderSanityChecks(slot.key, undefined, FILE_SCHEMAS[slot.key]);
      renderCsvWarnings(slot.key, undefined, () => {});

      try {
        const text = await file.text();
        const parsed = parseCsv(text);
        loadedFiles.set(slot.key, parsed);
        loadedFilenames.set(slot.key, file.name);
        refreshFileDisplay(slot.key);
      } catch (err) {
        loadedFiles.delete(slot.key);
        renderSanityChecks(slot.key, undefined, FILE_SCHEMAS[slot.key]);
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
    { header: "Scanner", get: (r) => r.scanner },
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
}
