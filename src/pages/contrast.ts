import { parseCsv, type ParsedCsv } from "../parseCsv";
import { parseXlsxFile } from "../parseXlsx";
import { runContrast, type ContrastOutputRow } from "../contrast";
import {
  runSanityChecks,
  hasBlockingIssues,
  CONTRAST_FILE_SCHEMAS,
  type TabularData,
} from "../sanityChecks";
import { toCsv, downloadCsv, type Column } from "../csvExport";
import { setStatus, setCount, renderSanityChecks, renderCsvWarnings } from "../uploadUi";
import { renderTable } from "../table";
import { renderPageNav } from "../nav";

type SlotKey = "contrastReport" | "technologists" | "cams";

interface FileSlot {
  key: SlotKey;
  label: string;
  accept: string;
  formats: string;
}

const SLOTS: FileSlot[] = [
  {
    key: "contrastReport",
    label: "Contrast Report",
    accept: ".xlsx,.csv",
    formats: "Excel (.xlsx) or CSV file",
  },
  { key: "technologists", label: "CAMRIS Technologists", accept: ".csv", formats: "CSV file" },
  { key: "cams", label: "CAMS Data", accept: ".csv", formats: "CSV file" },
];

const contrastColumns: Column<ContrastOutputRow>[] = [
  { header: "date", get: (r) => r.date },
  { header: "event_time", get: (r) => r.event_time },
  { header: "project", get: (r) => r.project },
  { header: "userid", get: (r) => r.userid },
  { header: "specimen", get: (r) => r.specimen },
  { header: "desc2", get: (r) => r.desc2, wrap: true },
  { header: "lab", get: (r) => String(r.lab) },
  { header: "sublab", get: (r) => String(r.sublab) },
  { header: "code", get: (r) => r.code },
  { header: "desc1", get: (r) => r.desc1 },
  { header: "quantity", get: (r) => String(r.quantity) },
  { header: "bill", get: (r) => r.bill },
];

export function renderContrastPage(app: HTMLElement): void {
  // Sanity checks and coded-value warnings work off `TabularData`
  // (fields + rows) alone, so this holds both CSV and Excel loads the
  // same way. Row-correction editing only makes sense for a genuine
  // CSV parse, so that's tracked separately, and only for the slot
  // that can be either — Contrast Report.
  const loadedData = new Map<SlotKey, TabularData>();
  const loadedFilenames = new Map<SlotKey, string>();
  let contrastReportParsedCsv: ParsedCsv | undefined;

  app.innerHTML = `
    ${renderPageNav("contrast")}
    <h1>Contrast Injection Billing</h1>
    <p class="subtitle">Upload the files below to build a contrast-injection billing file.</p>

    <div class="upload-grid">
      ${SLOTS.map(
        (slot) => `
        <div class="upload-slot">
          <div class="upload-row">
            <div class="upload-label">
              <label for="file-${slot.key}">${slot.label}</label>
              <span class="upload-formats">${slot.formats}</span>
            </div>
            <input type="file" id="file-${slot.key}" accept="${slot.accept}" />
            <span class="file-status" id="status-${slot.key}"></span>
          </div>
          <div id="sanity-${slot.key}"></div>
          <div id="warnings-${slot.key}"></div>
        </div>`
      ).join("")}
    </div>

    <button id="run-contrast" disabled>Generate Output</button>

    <div id="error-banner" class="error-banner" style="display: none;"></div>

    <div id="results" class="results">
      <div id="skipped-rows"></div>
      <div class="results-section">
        <div class="results-section-header">
          <h2>Contrast Injection Rows <span class="count" id="contrast-row-count"></span></h2>
          <button class="secondary" id="export-contrast">Export CSV</button>
        </div>
        <div class="table-wrap" id="contrast-table"></div>
      </div>
    </div>
  `;

  const runButton = document.getElementById("run-contrast") as HTMLButtonElement;
  const errorBanner = document.getElementById("error-banner")!;
  const resultsEl = document.getElementById("results")!;
  const skippedRowsEl = document.getElementById("skipped-rows")!;

  function updateRunButtonState(): void {
    const missingAFile = SLOTS.some((slot) => !loadedData.has(slot.key));
    const hasBlockingSanityIssue = SLOTS.some((slot) => {
      const data = loadedData.get(slot.key);
      return data
        ? hasBlockingIssues(
            runSanityChecks(CONTRAST_FILE_SCHEMAS[slot.key], data)
          )
        : false;
    });
    runButton.disabled = missingAFile || hasBlockingSanityIssue;
  }

  function refreshFileDisplay(key: SlotKey): void {
    const data = loadedData.get(key);
    const filename = loadedFilenames.get(key) ?? "file";
    if (!data) return;

    const isCsv = key === "contrastReport" ? contrastReportParsedCsv !== undefined : true;
    const parsedCsv =
      key === "contrastReport" ? contrastReportParsedCsv : (data as ParsedCsv);
    const warningCount = isCsv ? parsedCsv!.warnings.length : 0;

    if (warningCount > 0) {
      setStatus(
        key,
        `${filename} — ${data.rows.length} rows (${warningCount} had formatting issues)`,
        "warning"
      );
    } else {
      setStatus(key, `${filename} — ${data.rows.length} rows`, "loaded");
    }

    const sanityResult = renderSanityChecks(
      key,
      data,
      CONTRAST_FILE_SCHEMAS[key]
    );

    const csvWarningsContainer = document.getElementById(`warnings-${key}`)!;
    csvWarningsContainer.innerHTML = "";
    if (!hasBlockingIssues(sanityResult) && isCsv) {
      renderCsvWarnings(key, parsedCsv, (corrected) => {
        loadedData.set(key, corrected);
        if (key === "contrastReport") contrastReportParsedCsv = corrected;
        refreshFileDisplay(key);
        updateRunButtonState();
      });
    }
  }

  for (const slot of SLOTS) {
    const input = document.getElementById(`file-${slot.key}`) as HTMLInputElement;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;

      // See the audit page for why this reset is needed: without it,
      // re-picking the same file would not fire another change event.
      input.value = "";

      errorBanner.style.display = "none";
      setStatus(slot.key, `Reading ${file.name}...`);
      loadedData.delete(slot.key);
      if (slot.key === "contrastReport") contrastReportParsedCsv = undefined;
      renderSanityChecks(slot.key, undefined, CONTRAST_FILE_SCHEMAS[slot.key]);
      renderCsvWarnings(slot.key, undefined, () => {});

      try {
        const isXlsx =
          slot.key === "contrastReport" &&
          file.name.toLowerCase().endsWith(".xlsx");
        if (isXlsx) {
          const sheet = await parseXlsxFile(file);
          loadedData.set(slot.key, sheet);
        } else {
          const text = await file.text();
          const parsed = parseCsv(text);
          loadedData.set(slot.key, parsed);
          if (slot.key === "contrastReport") contrastReportParsedCsv = parsed;
        }
        loadedFilenames.set(slot.key, file.name);
        refreshFileDisplay(slot.key);
      } catch (err) {
        loadedData.delete(slot.key);
        if (slot.key === "contrastReport") contrastReportParsedCsv = undefined;
        renderSanityChecks(slot.key, undefined, CONTRAST_FILE_SCHEMAS[slot.key]);
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

  function renderSkippedRows(skippedNoMeds: number, skippedNoTechMatch: number): void {
    skippedRowsEl.innerHTML = "";
    if (skippedNoMeds === 0 && skippedNoTechMatch === 0) return;

    const details = document.createElement("details");
    details.className = "detail-box sanity-warnings";
    details.open = true;

    const total = skippedNoMeds + skippedNoTechMatch;
    const summary = document.createElement("summary");
    summary.textContent = `${total} Contrast Report row${total === 1 ? "" : "s"} skipped`;
    details.appendChild(summary);

    if (skippedNoMeds > 0) {
      const p = document.createElement("p");
      p.className = "sanity-warning-line";
      p.textContent = `${skippedNoMeds} row${
        skippedNoMeds === 1 ? "" : "s"
      } skipped: no value in "Procedure-Related Meds".`;
      details.appendChild(p);
    }

    if (skippedNoTechMatch > 0) {
      const p = document.createElement("p");
      p.className = "sanity-warning-line";
      p.textContent = `${skippedNoTechMatch} row${
        skippedNoTechMatch === 1 ? "" : "s"
      } skipped: technologist not found in CAMRIS Technologists.`;
      details.appendChild(p);
    }

    skippedRowsEl.appendChild(details);
  }

  let lastRows: ContrastOutputRow[] = [];

  runButton.addEventListener("click", () => {
    errorBanner.style.display = "none";

    try {
      const contrastRows = loadedData.get("contrastReport")!.rows;
      const technologistRows = loadedData.get("technologists")!.rows;

      const result = runContrast(contrastRows, technologistRows);
      lastRows = result.rows;

      setCount("contrast-row-count", result.rows.length);
      renderSkippedRows(result.skippedNoMeds, result.skippedNoTechMatch);
      renderTable(
        "contrast-table",
        contrastColumns,
        result.rows,
        "No contrast injection rows found."
      );

      resultsEl.classList.add("visible");
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      resultsEl.classList.remove("visible");
    }
  });

  document.getElementById("export-contrast")!.addEventListener("click", () => {
    downloadCsv("contrast_output.csv", toCsv(contrastColumns, lastRows));
  });
}
