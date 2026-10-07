import {
  decodeCsvBytes,
  parseCsv,
  type ParsedCsv,
} from "../parseCsv";
import {
  runAudit,
  buildRedcapLookup,
  TARGET_SCANNER,
  LATE_CANCELLATION_ALLOWANCE,
  NO_SHOW_SERVICE,
} from "../audit";
import {
  runSanityChecks,
  hasBlockingIssues,
  FILE_SCHEMAS,
} from "../sanityChecks";
import { toCsv, downloadBlob, type Column } from "../csvExport";
import type {
  AddOnWithoutMriRow,
  AuditResult,
  DedupedMismatchRow,
  FeeOnExternalProtocolRow,
  HumanMriExternalEventRow,
  LateCancellationRow,
  NoShowOnProdevRow,
  ProdevConsistencyRow,
  ProtocolIssueRow,
  RedcapNameCollision,
  ScannerEventRow,
  ViolationIssueRow,
} from "../types";
import {
  MISMATCH_RULE_EXPLANATIONS,
  NO_SHOW_PRODEV_RULE_EXPLANATIONS,
  PRODEV_RULE_EXPLANATIONS,
  VIOLATION_RULE_EXPLANATIONS,
  renderRuleExplanations,
} from "../ruleExplanations";
import {
  setStatus,
  setCount,
  setCountText,
  renderSanityChecks,
  renderCsvWarnings,
  renderRedcapCollisions,
} from "../uploadUi";
import { renderTable, sortedRows } from "../table";
import { renderPageNav } from "../nav";
import {
  DECISION_KEYS,
  countNeedingDecision,
  emptyDecisionStore,
  eventsAllDontFix,
  type Decision,
  type DecisionTableId,
} from "../decisions";
import {
  DECISION_TABLE_IDS,
  carryDecisions,
  earlierDecisionColumns,
  earlierDecisionRows,
  findReversals,
  removedIds,
  sincePreviousLabels,
  type EarlierDecisionRow,
  type PreviousAudit,
  type Reversal,
} from "../previousAudit";
import { decisionTableUi, type DecisionContext } from "../decisionUi";
import {
  AUDIT_INPUT_KEYS,
  DECISION_REPORT_FILES,
  EARLIER_DECISIONS_FILE,
  buildSavedAudit,
  localDate,
  localTimestamp,
  newAuditId,
  openSavedAudit,
  savedAuditFilename,
  scanTimeRange,
  type AuditInputFile,
  type AuditInputKey,
  type RemovedDecision,
  type ReportFile,
  type ScanRange,
} from "../savedAudit";
import { confirmLeave, setLeaveGuard } from "../leaveGuard";
import {
  emptyKeySets,
  prepareSavedAudit,
  previousAuditFromSaved,
  type PreparedSavedAudit,
} from "../restoreAudit";

interface FileSlot {
  key: AuditInputKey;
  label: string;
  accept: string;
  formats: string;
}

// The heading of the rule-explanation panel under both violations tables,
// which list issues as rows, not as columns.
const VIOLATION_SUMMARY = "What do these issues mean?";

/** "1 error", "2 errors", and so on. */
function countOf(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** A table's count text, followed by how many of its rows still need a
 * decision, for example "12 · 3 need a decision". */
function withDecisionCount(base: string, rows: number, needing: number): string {
  if (rows === 0) return base;
  const status =
    needing === 0
      ? "all decided"
      : `${needing} ${needing === 1 ? "needs" : "need"} a decision`;
  return `${base} · ${status}`;
}

/** "at 14:12" today, else "on 2026-09-30 at 14:12". */
function describeTime(at: Date): string {
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = localDate(at);
  return day === localDate(new Date()) ? `at ${time}` : `on ${day} at ${time}`;
}

/** The audit as it was last run: the inputs it ran on, for saving. */
interface AuditRun {
  inputs: Record<AuditInputKey, AuditInputFile>;
  dogfishScanRange: ScanRange | null;
}

const SLOTS: FileSlot[] = [
  { key: "dogfish", label: "Dogfish Events", accept: ".csv", formats: "CSV file" },
  { key: "cams", label: "CAMS Data", accept: ".csv", formats: "CSV file" },
  { key: "redcap", label: "REDCap Export", accept: ".csv", formats: "CSV file" },
];

/** "new": upload three exports and start an audit. "open": upload a
 * saved audit and continue it. */
export type AuditMode = "new" | "open";

/** A saved audit already read and checked, and the name of its file. */
interface OpenedSavedAudit {
  filename: string;
  prepared: PreparedSavedAudit;
}

/** Renders the Audit Tool page in `mode`. `opened`, in "open" mode, is a
 * saved audit to show as soon as the page is ready. */
export function renderAuditPage(
  app: HTMLElement,
  mode: AuditMode = "new",
  opened?: OpenedSavedAudit
): void {
  const loadedFiles = new Map<FileSlot["key"], ParsedCsv>();
  const loadedFilenames = new Map<FileSlot["key"], string>();
  // Each file exactly as uploaded, for the saved audit.
  const loadedBytes = new Map<FileSlot["key"], Uint8Array>();

  app.innerHTML = `
    ${renderPageNav("audit")}
    <h1>CAMRIS Billing Audit</h1>

    <div class="mode-switch">
      <button type="button" class="mode-tab" data-mode="new" aria-pressed="${mode === "new"}">Start a new audit</button>
      <button type="button" class="mode-tab" data-mode="open" aria-pressed="${mode === "open"}">Open a saved audit</button>
    </div>

    ${
      mode === "new"
        ? `<p class="subtitle">Upload the three exports below to check billing events against the audit rules.</p>`
        : `<p class="subtitle">Upload a saved audit (.zip) to continue it. Its three input files, row corrections, and decisions are restored, and the audit runs again.</p>
    <div class="upload-grid">
      <div class="upload-slot">
        <div class="upload-row">
          <div class="upload-label">
            <label for="file-saved">Saved Audit</label>
            <span class="upload-formats">.zip file</span>
          </div>
          <input type="file" id="file-saved" accept=".zip" />
          <span class="file-status" id="status-saved"></span>
        </div>
        <div id="saved-audit-note"></div>
      </div>
    </div>`
    }

    <div class="upload-grid">
      ${SLOTS.map(
        (slot) => `
        <div class="upload-slot">
          <div class="upload-row">
            <div class="upload-label">
              <label for="file-${slot.key}">${slot.label}</label>
              <span class="upload-formats">${slot.formats}</span>
            </div>
            ${
              mode === "new"
                ? `<input type="file" id="file-${slot.key}" accept="${slot.accept}" />`
                : `<span class="upload-readonly">From the saved audit</span>`
            }
            <span class="file-status" id="status-${slot.key}"></span>
          </div>
          <div id="sanity-${slot.key}"></div>
          <div id="warnings-${slot.key}"></div>
          ${slot.key === "redcap" ? '<div id="redcap-collisions"></div>' : ""}
        </div>`
      ).join("")}
      ${
        mode === "new"
          ? `<div class="upload-slot">
        <div class="upload-row">
          <div class="upload-label">
            <label for="file-previous">Previous Audit</label>
            <span class="upload-formats">Optional .zip file</span>
          </div>
          <input type="file" id="file-previous" accept=".zip" />
          <span class="file-status" id="status-previous"></span>
        </div>
        <p class="table-note">A saved audit to compare with. Its "Don't fix" decisions are filled in for a reviewer to confirm, row by row.</p>
      </div>`
          : ""
      }
    </div>

    <div class="run-row">
      <button id="run-audit" disabled>Run Audit</button>
      <label class="reviewer-field">
        Your initials
        <input type="text" id="reviewer-initials" maxlength="10" autocomplete="off" />
      </label>
    </div>

    <div id="error-banner" class="error-banner" style="display: none;"></div>

    <div id="results" class="results">
      <div class="save-bar">
        <button id="save-audit">Save audit (.zip)</button>
        <span class="save-status" id="save-status"></span>
      </div>
      <p class="table-note save-note">The saved audit holds the three input files as uploaded, any row corrections made here, and every table below with its decisions. Store it with the same care as the exports themselves.</p>

      <div class="results-section">
        <div class="results-section-header">
          <h2>Violations by Protocol <span class="count" id="protocol-issue-count"></span></h2>
        </div>
        <div class="table-wrap" id="protocol-issues-table"></div>
        ${renderRuleExplanations(VIOLATION_RULE_EXPLANATIONS, VIOLATION_SUMMARY)}
      </div>

      <div class="results-section">
        <div class="results-section-header">
          <h2>Violations by Event <span class="count" id="violation-issue-count"></span></h2>
          <label class="table-filter">
            <input type="checkbox" id="hide-dont-fix-events" />
            Hide events whose violations are all Don't fix
          </label>
        </div>
        <div class="table-wrap" id="violation-issues-table"></div>
        ${renderRuleExplanations(VIOLATION_RULE_EXPLANATIONS, VIOLATION_SUMMARY)}
      </div>

      <div class="results-section">
        <div class="results-section-header">
          <h2>Mismatches <span class="count" id="mismatch-count"></span></h2>
        </div>
        <div class="table-wrap" id="mismatches-table"></div>
        ${renderRuleExplanations(MISMATCH_RULE_EXPLANATIONS)}
      </div>

      <div class="results-section">
        <div class="results-section-header">
          <h2>Prodev Naming Consistency <span class="count" id="prodev-consistency-count"></span></h2>
        </div>
        <div class="table-wrap" id="prodev-consistency-table"></div>
        ${renderRuleExplanations(PRODEV_RULE_EXPLANATIONS)}
      </div>

      <div class="results-section">
        <div class="results-section-header">
          <h2>Add-On Fees Without MRI <span class="count" id="addon-count"></span></h2>
        </div>
        <div class="table-wrap" id="addons-table"></div>
        <p class="table-note">Events billed for a Stimulus/Response Equipment and/or Neuroreader (Research Report Reader) fee with no MRI service code on the same event — these fees are meant to accompany a scan, so one alone is a data-quality flag independent of the CAMS/REDCap checks.</p>
      </div>

      <div class="results-section">
        <div class="results-section-header">
          <h2>Excess Late Cancellations <span class="count" id="late-cancellation-count"></span></h2>
        </div>
        <div class="table-wrap" id="late-cancellations-table"></div>
        <p class="table-note">Each protocol is allowed ${LATE_CANCELLATION_ALLOWANCE} late cancellation events ("${NO_SHOW_SERVICE}") per calendar month, the month taken from Scan Time. Once a protocol goes past that in a month, every later cancellation event that month is listed here — one row per event, with its Event ID. Events are ordered by Scan Time then Event ID, so the first ${LATE_CANCELLATION_ALLOWANCE} in the month are the ones treated as within allowance. Protocols are grouped by their exact Dogfish Protocol Number (no normalization).</p>
      </div>

      <div class="results-section">
        <div class="results-section-header">
          <h2>No-Shows Billed To Prodev Protocols <span class="count" id="no-show-prodev-count"></span></h2>
        </div>
        <div class="table-wrap" id="no-show-prodev-table"></div>
        <p class="table-note">Every "${NO_SHOW_SERVICE}" event on a Prodev protocol — one row per event, with its Event ID. A protocol counts as Prodev when its number ends with "-P", "_P", or "Prodev", or when another event in this upload billed that exact protocol number at a Prodev tier. Protocols are matched by their exact Dogfish Protocol Number (no normalization).</p>
        ${renderRuleExplanations(NO_SHOW_PRODEV_RULE_EXPLANATIONS)}
      </div>

      <div class="results-section">
        <div class="results-section-header">
          <h2>Stimulus/Reader Fees On External Protocols <span class="count" id="external-fees-count"></span></h2>
        </div>
        <div class="table-wrap" id="external-fees-table"></div>
        <p class="table-note">Every event that billed a Stimulus/Response Equipment or Neuroreader (Research Report Reader) fee, at either the standard or the industry rate, on an external protocol — one row per event, with its Event ID. External protocols should never bill these fees. No data source outside Dogfish marks a protocol as external, so a protocol counts as external when the event itself billed the external MRI rate ("Human MRI (industry/external)" or the old label, "Human MRI (external)"), or when another event in this upload billed that exact protocol number at the external rate. Protocols are matched by their exact Dogfish Protocol Number (no normalization).</p>
      </div>

      <div class="results-section">
        <div class="results-section-header">
          <h2>${TARGET_SCANNER} Scanner Events <span class="count" id="scanner-event-count"></span></h2>
        </div>
        <div class="table-wrap" id="scanner-events-table"></div>
        <p class="table-note">Every Dogfish row on the ${TARGET_SCANNER} scanner, including no-shows and late cancellations — not filtered by any audit rule.</p>
      </div>

      <div class="results-section">
        <div class="results-section-header">
          <h2>Human MRI (Industry/External) Events <span class="count" id="human-mri-external-count"></span></h2>
        </div>
        <div class="table-wrap" id="human-mri-external-table"></div>
        <p class="table-note">Every Dogfish row billed at the external MRI rate, on any scanner — not filtered by any audit rule. This includes both the current label, "Human MRI (industry/external)", and the old label, "Human MRI (external)". The Service column shows which one each row used.</p>
      </div>

      <div class="results-section" id="earlier-section" hidden>
        <details class="earlier-decisions">
          <summary>
            <h2>Earlier Decisions Not Flagged <span class="count" id="earlier-count"></span></h2>
          </summary>
          <p class="table-note">Decisions from the previous audit whose rows this audit does not flag. Each "Don't fix" here moves forward to the next audit, so it is ready if the row is flagged again; remove it with ✕ to stop that. A "Fix" is listed once, when this upload covers the scans it was flagged on, as resolved, unless a row of Violations by Protocol reverses it.
          <div class="table-wrap" id="earlier-table"></div>
        </details>
      </div>
    </div>
  `;

  const runButton = document.getElementById("run-audit") as HTMLButtonElement;
  const errorBanner = document.getElementById("error-banner")!;
  const resultsEl = document.getElementById("results")!;

  let redcapCollisions: RedcapNameCollision[] = [];

  function updateRunButtonState(): void {
    const missingAFile = SLOTS.some((slot) => !loadedFiles.has(slot.key));
    const hasBlockingSanityIssue = SLOTS.some((slot) => {
      const parsed = loadedFiles.get(slot.key);
      return parsed
        ? hasBlockingIssues(runSanityChecks(FILE_SCHEMAS[slot.key], parsed))
        : false;
    });
    runButton.disabled =
      missingAFile || hasBlockingSanityIssue || redcapCollisions.length > 0;
  }

  /** Shows the REDCap name collisions, which block the audit. */
  function showRedcapCollisions(collisions: RedcapNameCollision[]): void {
    redcapCollisions = collisions;
    renderRedcapCollisions("redcap-collisions", collisions);
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
      renderCsvWarnings(key, { parsed, filename }, (corrected) => {
        loadedFiles.set(key, corrected);
        refreshFileDisplay(key);
        updateRunButtonState();
      });
    }

    if (key === "redcap") {
      showRedcapCollisions(
        hasBlockingIssues(sanityResult)
          ? []
          : buildRedcapLookup(parsed.rows).collisions
      );
    }
  }

  /** Puts one input file on the page: `bytes` as uploaded, and `parsed`,
   * its parse with any row corrections already applied. */
  function loadInput(
    key: FileSlot["key"],
    filename: string,
    bytes: Uint8Array,
    parsed: ParsedCsv
  ): void {
    loadedFiles.set(key, parsed);
    loadedFilenames.set(key, filename);
    loadedBytes.set(key, bytes);
    refreshFileDisplay(key);
  }

  // In "open" mode the inputs come only from the saved audit, so the
  // three slots have no file pickers.
  for (const slot of mode === "new" ? SLOTS : []) {
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
      if (slot.key === "redcap") showRedcapCollisions([]);

      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        loadInput(slot.key, file.name, bytes, parseCsv(decodeCsvBytes(bytes)));
      } catch (err) {
        loadedFiles.delete(slot.key);
        renderSanityChecks(slot.key, undefined, FILE_SCHEMAS[slot.key]);
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

  // The decisions outlive each run of the audit, so re-running it (after
  // a row correction, say) keeps them.
  const decisions = emptyDecisionStore();
  const reviewerInput = document.getElementById(
    "reviewer-initials"
  ) as HTMLInputElement;
  const saveButton = document.getElementById("save-audit") as HTMLButtonElement;
  const saveStatus = document.getElementById("save-status")!;
  const hideDontFixEvents = document.getElementById(
    "hide-dont-fix-events"
  ) as HTMLInputElement;

  // The audit as last run, for saving. Its ID and creation time stay the
  // same across re-runs on this page.
  let lastRun: AuditRun | null = null;
  let auditId: string | null = null;
  let createdAt = "";
  // True when the audit has been run or a decision changed since the
  // last save.
  let unsaved = false;
  let lastSaved: { filename: string; at: Date } | null = null;

  // The previous audit, for reference, and what this audit has done with
  // it. `considered` holds each table's keys whose previous decision was
  // already weighed for filling in (see carryDecisions).
  let previousAudit: PreviousAudit | null = null;
  let considered = emptyKeySets();
  let removedDecisions: RemovedDecision[] = [];
  // From the last run: each decision key's Since Previous Audit label,
  // the keys each table flags, and the earlier decisions this audit does
  // not flag.
  let sincePrevious: Record<DecisionTableId, Map<string, string>> = {
    protocolIssues: new Map(),
    mismatches: new Map(),
    prodevConsistency: new Map(),
    humanMriExternal: new Map(),
  };
  let flaggedKeys = emptyKeySets();
  // The Violations by Protocol rows that reverse a previous "Fix" (see
  // findReversals).
  let reversals = new Map<string, Reversal>();
  let earlierRows: EarlierDecisionRow[] = [];

  const hasAnyDecision = () =>
    Object.values(decisions).some((byKey: Map<string, Decision>) => byKey.size > 0);

  setLeaveGuard(() =>
    unsaved && hasAnyDecision()
      ? "This audit has decisions that are not in a saved audit. Leave anyway and lose them?"
      : null
  );

  const decisionContext: DecisionContext = {
    reviewer: () => reviewerInput.value,
    today: () => localDate(new Date()),
    onChange: () => {
      unsaved = true;
      refreshDecisionCounts();
      refreshSaveStatus();
      renderViolationIssues();
    },
  };

  const protocolIssueDecisions = decisionTableUi(
    DECISION_KEYS.protocolIssues,
    decisions.protocolIssues,
    decisionContext
  );
  const mismatchDecisions = decisionTableUi(
    DECISION_KEYS.mismatches,
    decisions.mismatches,
    decisionContext
  );
  const prodevConsistencyDecisions = decisionTableUi(
    DECISION_KEYS.prodevConsistency,
    decisions.prodevConsistency,
    decisionContext
  );
  const humanMriExternalDecisions = decisionTableUi(
    DECISION_KEYS.humanMriExternal,
    decisions.humanMriExternal,
    decisionContext
  );

  reviewerInput.addEventListener("input", () => {
    for (const ui of [
      protocolIssueDecisions,
      mismatchDecisions,
      prodevConsistencyDecisions,
      humanMriExternalDecisions,
    ]) {
      ui.refreshAll();
    }
  });

  /** A decision table's Since Previous Audit column: how each row
   * compares with the previous audit. Left out, on screen and in the CSV,
   * when there is no previous audit. */
  function sincePreviousColumn<T>(
    table: DecisionTableId,
    keyFn: (row: T) => string
  ): Column<T> {
    return {
      header: "Since Previous Audit",
      get: (row) => sincePrevious[table].get(keyFn(row)) ?? "",
      shown: () => previousAudit !== null,
    };
  }

  // Each column list below drives both the table on screen and its CSV
  // file in the saved audit, so the two always match.
  const violationIssueColumns: Column<ViolationIssueRow>[] = [
    { header: "Event ID", get: (r) => r.eventId },
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Scan Time", get: (r) => r.scanTime },
    { header: "Scanner", get: (r) => r.scanner },
    { header: "Issue", get: (r) => r.issue },
    { header: "Disagreeing Source", get: (r) => r.source },
  ];

  const protocolIssueColumns: Column<ProtocolIssueRow>[] = [
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Issue", get: (r) => r.issue },
    { header: "Disagreeing Source", get: (r) => r.source },
    { header: "Events", get: (r) => String(r.events) },
    { header: "First Scan", get: (r) => r.firstScan },
    { header: "Last Scan", get: (r) => r.lastScan },
    sincePreviousColumn("protocolIssues", DECISION_KEYS.protocolIssues),
    ...protocolIssueDecisions.columns,
  ];

  const mismatchColumns: Column<DedupedMismatchRow>[] = [
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Project Title", get: (r) => r.projectTitle, wrap: true },
    { header: "No CAMS Match", get: (r) => r.noCamsMatch },
    { header: "No Active REDCap Match", get: (r) => r.noActiveRedcapMatch },
    { header: "No REDCap Funding Type", get: (r) => r.noRedcapFundingType },
    { header: "Invalid Protocol Format", get: (r) => r.invalidProtocolFormat },
    sincePreviousColumn("mismatches", DECISION_KEYS.mismatches),
    ...mismatchDecisions.columns,
  ];

  const scannerEventColumns: Column<ScannerEventRow>[] = [
    { header: "Event ID", get: (r) => r.eventId },
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Project Title", get: (r) => r.projectTitle, wrap: true },
    { header: "Service", get: (r) => r.service },
    { header: "Scan Time", get: (r) => r.scanTime },
    { header: "Quantity", get: (r) => r.quantity },
    { header: "Mandatory Service", get: (r) => r.mandatoryService },
    { header: "Scheduling User", get: (r) => r.schedulingUser },
    { header: "Check-In User", get: (r) => r.checkInUser },
  ];

  const humanMriExternalColumns: Column<HumanMriExternalEventRow>[] = [
    { header: "Event ID", get: (r) => r.eventId },
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Project Title", get: (r) => r.projectTitle, wrap: true },
    { header: "Scanner", get: (r) => r.scanner },
    { header: "Service", get: (r) => r.service },
    { header: "Scan Time", get: (r) => r.scanTime },
    { header: "Quantity", get: (r) => r.quantity },
    { header: "Mandatory Service", get: (r) => r.mandatoryService },
    { header: "Scheduling User", get: (r) => r.schedulingUser },
    { header: "Check-In User", get: (r) => r.checkInUser },
    sincePreviousColumn("humanMriExternal", DECISION_KEYS.humanMriExternal),
    ...humanMriExternalDecisions.columns,
  ];

  const prodevConsistencyColumns: Column<ProdevConsistencyRow>[] = [
    { header: "Event ID", get: (r) => r.eventId },
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Project Title", get: (r) => r.projectTitle, wrap: true },
    { header: "Scan Time", get: (r) => r.scanTime },
    { header: "Scanner", get: (r) => r.scanner },
    { header: "Prodev Service Billed", get: (r) => r.prodevServiceBilled },
    { header: "Prodev Service Without Suffix", get: (r) => r.prodevServiceWithoutSuffix },
    { header: "Suffix Without Prodev Service", get: (r) => r.suffixWithoutProdevService },
    sincePreviousColumn("prodevConsistency", DECISION_KEYS.prodevConsistency),
    ...prodevConsistencyDecisions.columns,
  ];

  const addOnColumns: Column<AddOnWithoutMriRow>[] = [
    { header: "Event ID", get: (r) => r.eventId },
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Stimulus", get: (r) => r.stimulus },
    { header: "Neuroreader", get: (r) => r.neuroreader },
  ];

  const lateCancellationColumns: Column<LateCancellationRow>[] = [
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Month", get: (r) => r.month },
    { header: "Event ID", get: (r) => r.eventId },
    { header: "Scan Time", get: (r) => r.scanTime },
    { header: "Scanner", get: (r) => r.scanner },
    { header: "Project Title", get: (r) => r.projectTitle, wrap: true },
    { header: "Cancellations In Month", get: (r) => String(r.cancellationsInMonth) },
  ];

  const noShowProdevColumns: Column<NoShowOnProdevRow>[] = [
    { header: "Event ID", get: (r) => r.eventId },
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Project Title", get: (r) => r.projectTitle, wrap: true },
    { header: "Scan Time", get: (r) => r.scanTime },
    { header: "Scanner", get: (r) => r.scanner },
    { header: "Prodev Suffix", get: (r) => r.prodevSuffix },
    { header: "Prodev Billed On Protocol", get: (r) => r.prodevBilledOnProtocol },
    { header: "Prodev Services Billed", get: (r) => r.prodevServicesBilled },
  ];

  const externalFeeColumns: Column<FeeOnExternalProtocolRow>[] = [
    { header: "Event ID", get: (r) => r.eventId },
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Project Title", get: (r) => r.projectTitle, wrap: true },
    { header: "Scan Time", get: (r) => r.scanTime },
    { header: "Scanner", get: (r) => r.scanner },
    { header: "Fees Billed", get: (r) => r.feesBilled },
    { header: "External Rate Billed On", get: (r) => r.externalRateBilledOn },
  ];

  // The ✕ column removes an earlier decision so it stops moving forward.
  // It is an action, not data, so the CSV file leaves it out.
  const earlierColumns: Column<EarlierDecisionRow>[] = [
    ...earlierDecisionColumns(),
    {
      header: "",
      get: () => "",
      screenOnly: true,
      render: (row) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "remove-earlier";
        button.textContent = "✕";
        button.title = "Stop carrying this decision into later audits";
        button.setAttribute("aria-label", button.title);
        button.addEventListener("click", () => {
          if (
            !window.confirm(
              "Stop carrying this decision into later audits? It will not be in the saved audit."
            )
          ) {
            return;
          }
          removedDecisions.push({ table: row.table, keyCells: row.keyCells });
          refreshEarlierDecisions();
          unsaved = true;
          refreshSaveStatus();
        });
        return button;
      },
    },
  ];

  let lastResult: AuditResult = {
    violations: [],
    violationIssues: [],
    protocolIssues: [],
    mismatches: [],
    dedupedMismatches: [],
    excessLateCancellations: [],
    noShowsOnProdevProtocols: [],
    scannerEvents: [],
    humanMriExternalEvents: [],
    prodevConsistencyIssues: [],
    addOnsWithoutMri: [],
    feesOnExternalProtocols: [],
  };

  runButton.addEventListener("click", () => {
    errorBanner.style.display = "none";

    try {
      const dogfishRows = loadedFiles.get("dogfish")!.rows;
      const camsRows = loadedFiles.get("cams")!.rows;
      const redcapRows = loadedFiles.get("redcap")!.rows;

      lastResult = runAudit(dogfishRows, camsRows, redcapRows);
      lastRun = {
        inputs: auditedInputs(),
        dogfishScanRange: scanTimeRange(dogfishRows),
      };
      auditId ??= newAuditId();
      createdAt ||= localTimestamp(new Date());
      unsaved = true;
      compareWithPrevious();
      const {
        protocolIssues,
        dedupedMismatches,
        excessLateCancellations,
        noShowsOnProdevProtocols,
        scannerEvents,
        humanMriExternalEvents,
        prodevConsistencyIssues,
        addOnsWithoutMri,
        feesOnExternalProtocols,
      } = lastResult;

      refreshDecisionCounts();
      setCount("late-cancellation-count", excessLateCancellations.length);
      setCount("no-show-prodev-count", noShowsOnProdevProtocols.length);
      setCount("external-fees-count", feesOnExternalProtocols.length);
      setCount("scanner-event-count", scannerEvents.length);
      setCount("addon-count", addOnsWithoutMri.length);

      renderViolationIssues();
      protocolIssueDecisions.reset();
      renderTable(
        "protocol-issues-table",
        protocolIssueColumns,
        protocolIssues,
        "No violations found."
      );
      mismatchDecisions.reset();
      renderTable(
        "mismatches-table",
        mismatchColumns,
        dedupedMismatches,
        "No mismatches found."
      );
      renderTable(
        "late-cancellations-table",
        lateCancellationColumns,
        excessLateCancellations,
        `No protocol exceeded ${LATE_CANCELLATION_ALLOWANCE} late cancellations in a month.`
      );
      renderTable(
        "no-show-prodev-table",
        noShowProdevColumns,
        noShowsOnProdevProtocols,
        "No no-show events found on a Prodev protocol."
      );
      renderTable(
        "external-fees-table",
        externalFeeColumns,
        feesOnExternalProtocols,
        "No Stimulus or Neuroreader fees found on an external protocol."
      );
      renderTable(
        "scanner-events-table",
        scannerEventColumns,
        scannerEvents,
        `No events found on the ${TARGET_SCANNER} scanner.`
      );
      humanMriExternalDecisions.reset();
      renderTable(
        "human-mri-external-table",
        humanMriExternalColumns,
        humanMriExternalEvents,
        "No Human MRI (Industry/External) events found."
      );
      prodevConsistencyDecisions.reset();
      renderTable(
        "prodev-consistency-table",
        prodevConsistencyColumns,
        prodevConsistencyIssues,
        "No Prodev naming inconsistencies found."
      );
      renderTable(
        "addons-table",
        addOnColumns,
        addOnsWithoutMri,
        "No add-on fees found without an MRI service."
      );

      refreshSaveStatus();
      resultsEl.classList.add("visible");
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      resultsEl.classList.remove("visible");
    }
  });

  /** Shows the Violations by Event table and its count. With the filter
   * checked, an event whose every violation is "Don't fix" on Violations
   * by Protocol is hidden (see eventsAllDontFix). The filter is for the
   * screen only: the saved audit's CSV file has every event. */
  function renderViolationIssues(): void {
    const all = lastResult.violationIssues;
    const hidden = hideDontFixEvents.checked
      ? eventsAllDontFix(all, decisions.protocolIssues)
      : new Set<string>();
    const shown = all.filter((r) => !hidden.has(r.eventId));
    const eventCount = new Set(shown.map((r) => r.eventId)).size;
    setCountText(
      "violation-issue-count",
      `${countOf(shown.length, "error", "errors")} across ` +
        countOf(eventCount, "event", "events") +
        (hidden.size > 0 ? ` · ${countOf(hidden.size, "event", "events")} hidden` : "")
    );
    renderTable(
      "violation-issues-table",
      violationIssueColumns,
      shown,
      all.length > 0
        ? "Every event's violations are Don't fix."
        : "No violations found."
    );
  }

  hideDontFixEvents.addEventListener("change", renderViolationIssues);

  /** The inputs the audit is about to run on, for the saved audit. */
  function auditedInputs(): Record<AuditInputKey, AuditInputFile> {
    const inputs = {} as Record<AuditInputKey, AuditInputFile>;
    for (const slot of SLOTS) {
      inputs[slot.key] = {
        filename: loadedFilenames.get(slot.key)!,
        bytes: loadedBytes.get(slot.key)!,
        corrections: loadedFiles.get(slot.key)!.corrections,
      };
    }
    return inputs;
  }

  /** Updates the counts of the tables that take decisions, which include
   * how many rows still need one. */
  function refreshDecisionCounts(): void {
    const {
      protocolIssues,
      dedupedMismatches,
      prodevConsistencyIssues,
      humanMriExternalEvents,
    } = lastResult;
    const protocolCount = new Set(protocolIssues.map((r) => r.protocolNumber))
      .size;
    setCountText(
      "protocol-issue-count",
      withDecisionCount(
        `${countOf(protocolIssues.length, "error", "errors")} across ` +
          countOf(protocolCount, "protocol", "protocols"),
        protocolIssues.length,
        countNeedingDecision(
          protocolIssues,
          DECISION_KEYS.protocolIssues,
          decisions.protocolIssues
        )
      )
    );
    setCountText(
      "mismatch-count",
      withDecisionCount(
        String(dedupedMismatches.length),
        dedupedMismatches.length,
        countNeedingDecision(
          dedupedMismatches,
          DECISION_KEYS.mismatches,
          decisions.mismatches
        )
      )
    );
    setCountText(
      "prodev-consistency-count",
      withDecisionCount(
        String(prodevConsistencyIssues.length),
        prodevConsistencyIssues.length,
        countNeedingDecision(
          prodevConsistencyIssues,
          DECISION_KEYS.prodevConsistency,
          decisions.prodevConsistency
        )
      )
    );
    setCountText(
      "human-mri-external-count",
      withDecisionCount(
        String(humanMriExternalEvents.length),
        humanMriExternalEvents.length,
        countNeedingDecision(
          humanMriExternalEvents,
          DECISION_KEYS.humanMriExternal,
          decisions.humanMriExternal
        )
      )
    );
  }

  function refreshSaveStatus(): void {
    if (!lastRun) {
      saveStatus.textContent = "";
    } else if (!unsaved && lastSaved) {
      saveStatus.textContent = `Saved as ${lastSaved.filename} ${describeTime(lastSaved.at)}.`;
    } else if (lastSaved) {
      saveStatus.textContent = "Changed since the last save.";
    } else {
      saveStatus.textContent = "Not saved yet.";
    }
  }

  /** A table's CSV text, with its rows in the order the table shows them. */
  function tableCsv<T>(
    tableId: string,
    columns: Column<T>[],
    rows: T[]
  ): string {
    return toCsv(columns, sortedRows(tableId, columns, rows));
  }

  /** Every results table as CSV, in the order the page shows them, each
   * with its rows sorted as they are on screen. */
  function reportFiles(): ReportFile[] {
    return [
      {
        filename: DECISION_REPORT_FILES.protocolIssues,
        csv: tableCsv(
          "protocol-issues-table",
          protocolIssueColumns,
          lastResult.protocolIssues
        ),
      },
      {
        filename: "audit_violations.csv",
        csv: tableCsv(
          "violation-issues-table",
          violationIssueColumns,
          lastResult.violationIssues
        ),
      },
      {
        filename: DECISION_REPORT_FILES.mismatches,
        csv: tableCsv(
          "mismatches-table",
          mismatchColumns,
          lastResult.dedupedMismatches
        ),
      },
      {
        filename: DECISION_REPORT_FILES.prodevConsistency,
        csv: tableCsv(
          "prodev-consistency-table",
          prodevConsistencyColumns,
          lastResult.prodevConsistencyIssues
        ),
      },
      {
        filename: "addons_without_mri.csv",
        csv: tableCsv(
          "addons-table",
          addOnColumns,
          lastResult.addOnsWithoutMri
        ),
      },
      {
        filename: "excess_late_cancellations.csv",
        csv: tableCsv(
          "late-cancellations-table",
          lateCancellationColumns,
          lastResult.excessLateCancellations
        ),
      },
      {
        filename: "no_shows_on_prodev_protocols.csv",
        csv: tableCsv(
          "no-show-prodev-table",
          noShowProdevColumns,
          lastResult.noShowsOnProdevProtocols
        ),
      },
      {
        filename: "fees_on_external_protocols.csv",
        csv: tableCsv(
          "external-fees-table",
          externalFeeColumns,
          lastResult.feesOnExternalProtocols
        ),
      },
      {
        filename: `${TARGET_SCANNER.toLowerCase()}_scanner_events.csv`,
        csv: tableCsv(
          "scanner-events-table",
          scannerEventColumns,
          lastResult.scannerEvents
        ),
      },
      {
        filename: DECISION_REPORT_FILES.humanMriExternal,
        csv: tableCsv(
          "human-mri-external-table",
          humanMriExternalColumns,
          lastResult.humanMriExternalEvents
        ),
      },
      {
        filename: EARLIER_DECISIONS_FILE,
        csv: tableCsv("earlier-table", earlierColumns, earlierRows),
      },
    ];
  }

  /** Compares the last run with the previous audit: each decision row's
   * Since Previous Audit label, the previous "Don't fix" decisions filled
   * in on rows flagged again or reversed, and the earlier decisions this
   * audit does not flag. */
  function compareWithPrevious(): void {
    reversals = previousAudit
      ? findReversals(lastResult.protocolIssues, previousAudit.entries.protocolIssues)
      : new Map();
    sincePrevious = {
      protocolIssues: sincePreviousLabels(
        "protocolIssues",
        lastResult.protocolIssues,
        DECISION_KEYS.protocolIssues,
        (r) => r.source,
        previousAudit,
        reversals
      ),
      mismatches: sincePreviousLabels(
        "mismatches",
        lastResult.dedupedMismatches,
        DECISION_KEYS.mismatches,
        undefined,
        previousAudit
      ),
      prodevConsistency: sincePreviousLabels(
        "prodevConsistency",
        lastResult.prodevConsistencyIssues,
        DECISION_KEYS.prodevConsistency,
        undefined,
        previousAudit
      ),
      humanMriExternal: sincePreviousLabels(
        "humanMriExternal",
        lastResult.humanMriExternalEvents,
        DECISION_KEYS.humanMriExternal,
        undefined,
        previousAudit
      ),
    };
    flaggedKeys = {
      protocolIssues: new Set(lastResult.protocolIssues.map(DECISION_KEYS.protocolIssues)),
      mismatches: new Set(lastResult.dedupedMismatches.map(DECISION_KEYS.mismatches)),
      prodevConsistency: new Set(
        lastResult.prodevConsistencyIssues.map(DECISION_KEYS.prodevConsistency)
      ),
      humanMriExternal: new Set(
        lastResult.humanMriExternalEvents.map(DECISION_KEYS.humanMriExternal)
      ),
    };
    if (previousAudit) {
      for (const table of DECISION_TABLE_IDS) {
        carryDecisions(
          flaggedKeys[table],
          previousAudit.entries[table],
          decisions[table],
          considered[table],
          table === "protocolIssues" ? reversals : undefined
        );
      }
    }
    refreshEarlierDecisions();
  }

  /** Lists and shows the earlier decisions this audit does not flag. A
   * key flagged earlier in this session keeps the decision made on it. */
  function refreshEarlierDecisions(): void {
    earlierRows = earlierDecisionRows(
      previousAudit,
      flaggedKeys,
      lastRun?.dogfishScanRange ?? null,
      removedIds(removedDecisions),
      reversals
    ).map((row) => ({
      ...row,
      decision: decisions[row.table].get(row.key) ?? row.decision,
    }));
    document.getElementById("earlier-section")!.hidden = previousAudit === null;
    setCount("earlier-count", earlierRows.length);
    renderTable(
      "earlier-table",
      earlierColumns,
      earlierRows,
      "No earlier decisions to carry forward."
    );
  }

  saveButton.addEventListener("click", () => {
    if (!lastRun || !auditId) return;
    const now = new Date();
    const { zip } = buildSavedAudit({
      auditId,
      createdAt,
      savedAt: localTimestamp(now),
      savedBy: reviewerInput.value.trim(),
      appVersion: __APP_VERSION__,
      dogfishScanRange: lastRun.dogfishScanRange,
      inputs: lastRun.inputs,
      reports: reportFiles(),
      previous: previousAudit && {
        record: { ...previousAudit.record, removedDecisions },
        reports: [...previousAudit.reports].map(([filename, csv]) => ({
          filename,
          csv,
        })),
      },
    });
    const filename = savedAuditFilename(lastRun.dogfishScanRange, now);
    // fflate types its output as a view on any buffer, but it is always a
    // plain ArrayBuffer, which is what Blob accepts.
    const bytes = zip as Uint8Array<ArrayBuffer>;
    downloadBlob(filename, new Blob([bytes], { type: "application/zip" }));
    unsaved = false;
    lastSaved = { filename, at: now };
    refreshSaveStatus();
  });

  for (const tab of app.querySelectorAll<HTMLButtonElement>(".mode-tab")) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.mode as AuditMode;
      if (target !== mode && confirmLeave()) renderAuditPage(app, target);
    });
  }

  /** Restores a saved audit on this page and runs it again. */
  function showSaved({ filename: zipName, prepared }: OpenedSavedAudit): void {
    const { manifest } = prepared;

    for (const key of AUDIT_INPUT_KEYS) {
      const { filename, bytes, parsed } = prepared.inputs[key];
      loadInput(key, filename, bytes, parsed);
    }
    for (const table of Object.keys(decisions) as DecisionTableId[]) {
      decisions[table].clear();
      for (const [key, decision] of prepared.decisions[table]) {
        decisions[table].set(key, decision);
      }
    }
    auditId = manifest.auditId;
    createdAt = manifest.createdAt;
    previousAudit = prepared.previous;
    considered = prepared.considered;
    removedDecisions = prepared.previous?.record.removedDecisions ?? [];

    const savedAt = new Date(manifest.savedAt);
    const by = manifest.savedBy ? ` by ${manifest.savedBy}` : "";
    setStatus(
      "saved",
      `${zipName} — saved ${describeTime(savedAt)}${by}`,
      "loaded"
    );
    renderVersionNote(manifest.appVersion);
    if (prepared.previous) {
      const { savedAt: previousSavedAt, savedBy } = prepared.previous.record;
      const note = document.createElement("p");
      note.className = "table-note";
      note.textContent =
        `Compared with the previous audit saved ` +
        `${describeTime(new Date(previousSavedAt))}${savedBy ? ` by ${savedBy}` : ""}.`;
      document.getElementById("saved-audit-note")!.appendChild(note);
    }

    updateRunButtonState();
    if (!runButton.disabled) runButton.click();
    // Opening changes nothing: the page matches the file just opened.
    unsaved = false;
    lastSaved = { filename: zipName, at: savedAt };
    refreshSaveStatus();
  }

  /** Says so when the saved audit came from a different build of the
   * tool, whose rules may give different results. */
  function renderVersionNote(savedVersion: string): void {
    const container = document.getElementById("saved-audit-note")!;
    container.innerHTML = "";
    if (savedVersion === __APP_VERSION__) return;
    const note = document.createElement("p");
    note.className = "detail-box";
    note.textContent =
      `This audit was saved by version ${savedVersion} of the tool; this is ` +
      `version ${__APP_VERSION__}. If the audit rules changed in between, the ` +
      "results can differ from when it was saved. Decisions are matched to " +
      "the new results by their protocol (and issue, where the table has " +
      "one), but a decision whose row is no longer flagged is not kept when " +
      "you save.";
    container.appendChild(note);
  }

  if (mode === "open") {
    const input = document.getElementById("file-saved") as HTMLInputElement;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;

      // Read and check the whole file before changing the page, so a
      // wrong or damaged file leaves an open audit as it was.
      const hasAudit = loadedFiles.size > 0;
      errorBanner.style.display = "none";
      if (!hasAudit) setStatus("saved", `Reading ${file.name}...`);
      let prepared: PreparedSavedAudit;
      try {
        prepared = prepareSavedAudit(new Uint8Array(await file.arrayBuffer()));
      } catch (err) {
        if (!hasAudit) setStatus("saved", `Failed to open ${file.name}`);
        const why = err instanceof Error ? err.message : String(err);
        showError(`${file.name}: ${why}`);
        return;
      }

      // A second saved audit replaces everything on the page.
      const next = { filename: file.name, prepared };
      if (!hasAudit) showSaved(next);
      else if (confirmLeave()) renderAuditPage(app, "open", next);
    });
    if (opened) showSaved(opened);
  }

  /** Uses `next` as the previous audit, in place of any other. */
  function usePrevious(next: PreviousAudit, status: string): void {
    previousAudit = next;
    considered = emptyKeySets();
    removedDecisions = [];
    // Decisions filled in from another previous audit, and not confirmed,
    // do not belong to this one.
    for (const table of DECISION_TABLE_IDS) {
      for (const [key, decision] of decisions[table]) {
        if (decision.unconfirmed) decisions[table].delete(key);
      }
    }
    setStatus("previous", status, "loaded");
    if (lastRun && !runButton.disabled) runButton.click();
  }

  if (mode === "new") {
    const input = document.getElementById("file-previous") as HTMLInputElement;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      errorBanner.style.display = "none";
      setStatus("previous", `Reading ${file.name}...`);
      let next: PreviousAudit;
      try {
        next = previousAuditFromSaved(
          openSavedAudit(new Uint8Array(await file.arrayBuffer()))
        );
      } catch (err) {
        setStatus("previous", `Failed to read ${file.name}`);
        const why = err instanceof Error ? err.message : String(err);
        showError(`${file.name}: ${why}`);
        return;
      }
      const { savedAt, savedBy } = next.record;
      usePrevious(
        next,
        `${file.name} — saved ${describeTime(new Date(savedAt))}${savedBy ? ` by ${savedBy}` : ""}`
      );
    });
  }
}
