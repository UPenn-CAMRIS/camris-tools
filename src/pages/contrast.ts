import { parseCsv, readCsvFile, type ParsedCsv } from "../parseCsv";
import { parseXlsxFile } from "../parseXlsx";
import {
  CONTRAST_CODES,
  runContrast,
  type ContrastCode,
  type ContrastRow,
} from "../contrast";
import { buildRedcapLookup } from "../audit";
import {
  runSanityChecks,
  hasBlockingIssues,
  CONTRAST_FILE_SCHEMAS,
  type TabularData,
} from "../sanityChecks";
import type { CsvRow } from "../parseCsv";
import type { RedcapNameCollision } from "../types";
import { toCsv, downloadCsv, type Column } from "../csvExport";
import {
  setStatus,
  setCountText,
  renderSanityChecks,
  renderCsvWarnings,
  renderRedcapCollisions,
} from "../uploadUi";
import { renderTable, sortedRows } from "../table";
import { renderPageNav } from "../nav";
import { setLeaveGuard } from "../leaveGuard";
import {
  CONTRAST_RULE_EXPLANATIONS,
  renderRuleExplanations,
} from "../ruleExplanations";

type SlotKey = keyof typeof CONTRAST_FILE_SCHEMAS;

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
  { key: "redcap", label: "REDCap Export", accept: ".csv", formats: "CSV file" },
  { key: "dogfish", label: "Dogfish Events", accept: ".csv", formats: "CSV file" },
];

/** The columns of the billing file, in its order. Export billing CSV
 * writes these alone, so the file keeps the format the billing system
 * reads. */
const billingColumns: Column<ContrastRow>[] = [
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

/** True when a person picked a code other than the suggested one. */
function codeSetByHand(row: ContrastRow): boolean {
  return row.code !== row.suggestedCode;
}

/** True when some sources say industry and others say not industry. */
function sourcesDisagree(row: ContrastRow): boolean {
  return row.saysIndustry.length > 0 && row.saysNotIndustry.length > 0;
}

// Billing constants, the same on every row: in the billing CSV, but not
// on screen or in Export full table.
const BILLING_ONLY_HEADERS = new Set(["lab", "sublab", "quantity", "bill"]);

/** A list of sources on screen, one on each line, so the column is only
 * as wide as the longest source name. The CSV joins them with " + ". */
function sourceLines(sources: readonly string[]): Node {
  const cell = document.createElement("span");
  sources.forEach((source, i) => {
    if (i > 0) cell.appendChild(document.createElement("br"));
    cell.appendChild(document.createTextNode(source));
  });
  return cell;
}

/** The columns after the billing columns: how the code was chosen. On
 * screen, and in Export full table. */
const reviewColumns: Column<ContrastRow>[] = [
  { header: "Suggested Code", get: (r) => r.suggestedCode },
  {
    header: "Says Industry",
    get: (r) => r.saysIndustry.join(" + "),
    render: (r) => sourceLines(r.saysIndustry),
  },
  {
    header: "Says Not Industry",
    get: (r) => r.saysNotIndustry.join(" + "),
    render: (r) => sourceLines(r.saysNotIndustry),
  },
  { header: "REDCap CHOP", get: (r) => r.chop },
  { header: "Dogfish Event ID", get: (r) => r.dogfishEventId },
  { header: "MRI Service", get: (r) => r.mriService, wrap: true },
  { header: "Invalid Protocol Format", get: (r) => r.invalidProtocolFormat },
  {
    header: "Procedure-Related Meds",
    get: (r) => r.meds,
    wrap: true,
    wide: true,
  },
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
  let redcapCollisions: RedcapNameCollision[] = [];

  app.innerHTML = `
    ${renderPageNav("contrast")}
    <h1>Contrast Injection Billing</h1>
    <p class="subtitle">Upload the files below to build a contrast-injection billing file. The billing code is <code>CAMRIS-051</code> for industry-sponsored protocols, and <code>CAMRIS-003</code> otherwise. Three sources say whether a protocol is industry sponsored, read the same way the Audit Tool reads them: the MRI rate Dogfish billed for the same scan, CAMS, and REDCap. Each row's code is the one most of them point to, and you can change it in the table.</p>

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
          ${slot.key === "redcap" ? '<div id="redcap-collisions"></div>' : ""}
          <div id="warnings-${slot.key}"></div>
        </div>`
      ).join("")}
    </div>

    <button id="run-contrast" disabled>Generate Output</button>

    <div id="error-banner" class="error-banner" style="display: none;"></div>

    <div id="results" class="results">
      <div id="skipped-rows" class="skipped-rows"></div>
      <div class="results-section">
        <div class="results-section-header">
          <h2>Contrast Injection Rows <span class="count" id="contrast-row-count"></span></h2>
          <div class="button-row">
            <button class="secondary" id="export-contrast">Export billing CSV</button>
            <button class="secondary" id="export-full">Export full table</button>
          </div>
        </div>
        <p class="table-note">Export billing CSV writes the billing columns (<code>date</code> to <code>bill</code>) with the code chosen in the table. It stays off until every row has a code: a row whose sources have no answer starts with none. Export full table writes the table as shown.</p>
        <div class="table-wrap" id="contrast-table"></div>
        ${renderRuleExplanations(CONTRAST_RULE_EXPLANATIONS)}
      </div>
    </div>
  `;

  const runButton = document.getElementById("run-contrast") as HTMLButtonElement;
  const errorBanner = document.getElementById("error-banner")!;
  const resultsEl = document.getElementById("results")!;
  const skippedRowsEl = document.getElementById("skipped-rows")!;
  const exportBillingButton = document.getElementById(
    "export-contrast"
  ) as HTMLButtonElement;

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
    runButton.disabled =
      missingAFile || hasBlockingSanityIssue || redcapCollisions.length > 0;
  }

  /** Shows the REDCap name collisions, which block Generate Output the
   * same way they block the audit. */
  function showRedcapCollisions(collisions: RedcapNameCollision[]): void {
    redcapCollisions = collisions;
    renderRedcapCollisions("redcap-collisions", collisions);
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
      renderCsvWarnings(key, { parsed: parsedCsv!, filename }, (corrected) => {
        loadedData.set(key, corrected);
        if (key === "contrastReport") contrastReportParsedCsv = corrected;
        refreshFileDisplay(key);
        updateRunButtonState();
      });
    }

    if (key === "redcap") {
      showRedcapCollisions(
        hasBlockingIssues(sanityResult)
          ? []
          : buildRedcapLookup(data.rows as CsvRow[]).collisions
      );
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
      if (slot.key === "redcap") showRedcapCollisions([]);

      try {
        const isXlsx =
          slot.key === "contrastReport" &&
          file.name.toLowerCase().endsWith(".xlsx");
        if (isXlsx) {
          const sheet = await parseXlsxFile(file);
          loadedData.set(slot.key, sheet);
        } else {
          const text = await readCsvFile(file);
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
        if (slot.key === "redcap") showRedcapCollisions([]);
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

  let lastRows: ContrastRow[] = [];

  // The table on screen, which Export full table also writes: the
  // billing columns without the constants, with a drop-down for the
  // code, then the review columns.
  const tableColumns: Column<ContrastRow>[] = [
    ...billingColumns
      .filter((col) => !BILLING_ONLY_HEADERS.has(col.header))
      .map((col) =>
        col.header === "code" ? { ...col, render: renderCodeSelect } : col
      ),
    ...reviewColumns,
  ];

  function renderCodeSelect(row: ContrastRow): Node {
    const select = document.createElement("select");
    select.className = "code-select";
    select.setAttribute("aria-label", "Billing code");
    for (const value of ["", ...CONTRAST_CODES]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value || "—";
      select.appendChild(option);
    }
    select.value = row.code;
    select.classList.toggle("needs-code", row.code === "");
    select.addEventListener("change", () => {
      row.code = select.value as ContrastCode | "";
      select.classList.toggle("needs-code", row.code === "");
      refreshCount();
    });
    return select;
  }

  function refreshCount(): void {
    const parts = [`${lastRows.length} row${lastRows.length === 1 ? "" : "s"}`];
    const needCode = lastRows.filter((r) => r.code === "").length;
    if (needCode > 0) parts.push(`${needCode} need a code`);
    const disagree = lastRows.filter(sourcesDisagree).length;
    if (disagree > 0) {
      parts.push(`${disagree} with sources that disagree`);
    }
    const byHand = lastRows.filter(codeSetByHand).length;
    if (byHand > 0) parts.push(`${byHand} set by hand`);
    setCountText("contrast-row-count", parts.join(", "));

    exportBillingButton.disabled = needCode > 0;
    exportBillingButton.title =
      needCode > 0 ? "Choose a code for every row first." : "";
  }

  setLeaveGuard(() =>
    lastRows.some(codeSetByHand)
      ? "Codes you set by hand will be lost. Leave anyway?"
      : null
  );

  runButton.addEventListener("click", () => {
    errorBanner.style.display = "none";

    const byHand = lastRows.filter(codeSetByHand).length;
    if (
      byHand > 0 &&
      !window.confirm(
        `Generating the output again discards the ${byHand} code${
          byHand === 1 ? "" : "s"
        } you set by hand. Continue?`
      )
    ) {
      return;
    }

    try {
      const result = runContrast(
        loadedData.get("contrastReport")!.rows,
        loadedData.get("technologists")!.rows,
        loadedData.get("cams")!.rows,
        loadedData.get("redcap")!.rows as CsvRow[],
        loadedData.get("dogfish")!.rows as CsvRow[]
      );
      lastRows = result.rows;

      renderSkippedRows(result.skippedNoMeds, result.skippedNoTechMatch);
      renderTable(
        "contrast-table",
        tableColumns,
        result.rows,
        "No contrast injection rows found."
      );
      refreshCount();

      resultsEl.classList.add("visible");
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      resultsEl.classList.remove("visible");
    }
  });

  exportBillingButton.addEventListener("click", () => {
    downloadCsv(
      "contrast_output.csv",
      toCsv(
        billingColumns,
        sortedRows("contrast-table", tableColumns, lastRows)
      )
    );
  });

  document.getElementById("export-full")!.addEventListener("click", () => {
    downloadCsv(
      "contrast_full_table.csv",
      toCsv(tableColumns, sortedRows("contrast-table", tableColumns, lastRows))
    );
  });
}
