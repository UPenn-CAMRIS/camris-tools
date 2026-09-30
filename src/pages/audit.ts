import { decodeCsvBytes, parseCsv, type ParsedCsv } from "../parseCsv";
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
} from "../uploadUi";
import { renderTable } from "../table";
import { renderPageNav } from "../nav";
import {
  DECISION_KEYS,
  countNeedingDecision,
  emptyDecisionStore,
  type Decision,
} from "../decisions";
import { decisionTableUi, type DecisionContext } from "../decisionUi";
import {
  buildSavedAudit,
  localDate,
  localTimestamp,
  newAuditId,
  savedAuditFilename,
  scanTimeRange,
  type AuditInputFile,
  type AuditInputKey,
  type ReportFile,
  type ScanRange,
} from "../savedAudit";
import { setLeaveGuard } from "../leaveGuard";

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

export function renderAuditPage(app: HTMLElement): void {
  const loadedFiles = new Map<FileSlot["key"], ParsedCsv>();
  const loadedFilenames = new Map<FileSlot["key"], string>();
  // Each file exactly as uploaded, for the saved audit.
  const loadedBytes = new Map<FileSlot["key"], Uint8Array>();

  app.innerHTML = `
    ${renderPageNav("audit")}
    <h1>CAMRIS Billing Audit</h1>
    <p class="subtitle">Upload the three exports below to check billing events against the audit rules.</p>

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
          ${slot.key === "redcap" ? '<div id="redcap-collisions"></div>' : ""}
        </div>`
      ).join("")}
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

  /** REDCap's protocol field can name a protocol more than one way (see
   * buildRedcapLookup). A name shared between two rows that otherwise
   * disagree is a data problem, not a normal resubmission — this blocks
   * the audit the same as a missing required column. */
  function renderRedcapCollisions(collisions: RedcapNameCollision[]): void {
    const container = document.getElementById("redcap-collisions")!;
    container.innerHTML = "";
    redcapCollisions = collisions;
    if (collisions.length === 0) return;

    const box = document.createElement("div");
    box.className = "detail-box sanity-blocking";

    const title = document.createElement("p");
    title.className = "sanity-blocking-title";
    title.textContent = `This file has ${collisions.length} protocol identifier${
      collisions.length === 1 ? "" : "s"
    } shared between rows that otherwise look like different protocols.`;
    box.appendChild(title);

    const list = document.createElement("ul");
    for (const collision of collisions) {
      const li = document.createElement("li");
      const [a, b] = collision.protocolFields;
      li.textContent = `"${collision.name}" appears in both "${a}" and "${b}". Check REDCap for a typo or an accidental cross-reference to a different protocol.`;
      list.appendChild(li);
    }
    box.appendChild(list);

    container.appendChild(box);
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
      renderRedcapCollisions(
        hasBlockingIssues(sanityResult)
          ? []
          : buildRedcapLookup(parsed.rows).collisions
      );
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
      if (slot.key === "redcap") renderRedcapCollisions([]);

      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = parseCsv(decodeCsvBytes(bytes));
        loadedFiles.set(slot.key, parsed);
        loadedFilenames.set(slot.key, file.name);
        loadedBytes.set(slot.key, bytes);
        refreshFileDisplay(slot.key);
      } catch (err) {
        loadedFiles.delete(slot.key);
        renderSanityChecks(slot.key, undefined, FILE_SCHEMAS[slot.key]);
        setStatus(slot.key, `Failed to read ${file.name}`);
        showError(err instanceof Error ? err.message : String(err));
        if (slot.key === "redcap") renderRedcapCollisions([]);
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

  // The audit as last run, for saving. Its ID and creation time stay the
  // same across re-runs on this page.
  let lastRun: AuditRun | null = null;
  let auditId: string | null = null;
  let createdAt = "";
  // True when the audit has been run or a decision changed since the
  // last save.
  let unsaved = false;
  let lastSaved: { filename: string; at: Date } | null = null;

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
    ...protocolIssueDecisions.columns,
  ];

  const mismatchColumns: Column<DedupedMismatchRow>[] = [
    { header: "Protocol Number", get: (r) => r.protocolNumber },
    { header: "Project Title", get: (r) => r.projectTitle, wrap: true },
    { header: "No CAMS Match", get: (r) => r.noCamsMatch },
    { header: "No Active REDCap Match", get: (r) => r.noActiveRedcapMatch },
    { header: "No REDCap Funding Type", get: (r) => r.noRedcapFundingType },
    { header: "Invalid Protocol Format", get: (r) => r.invalidProtocolFormat },
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
      const {
        violationIssues,
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

      const eventCount = new Set(violationIssues.map((r) => r.eventId)).size;
      setCountText(
        "violation-issue-count",
        `${countOf(violationIssues.length, "error", "errors")} across ` +
          countOf(eventCount, "event", "events")
      );
      refreshDecisionCounts();
      setCount("late-cancellation-count", excessLateCancellations.length);
      setCount("no-show-prodev-count", noShowsOnProdevProtocols.length);
      setCount("external-fees-count", feesOnExternalProtocols.length);
      setCount("scanner-event-count", scannerEvents.length);
      setCount("addon-count", addOnsWithoutMri.length);

      renderTable(
        "violation-issues-table",
        violationIssueColumns,
        violationIssues,
        "No violations found."
      );
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
      const time = lastSaved.at.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      saveStatus.textContent = `Saved as ${lastSaved.filename} at ${time}.`;
    } else if (lastSaved) {
      saveStatus.textContent = "Changed since the last save.";
    } else {
      saveStatus.textContent = "Not saved yet.";
    }
  }

  /** Every results table as CSV, in the order the page shows them. */
  function reportFiles(): ReportFile[] {
    return [
      {
        filename: "audit_violations_by_protocol.csv",
        csv: toCsv(protocolIssueColumns, lastResult.protocolIssues),
      },
      {
        filename: "audit_violations.csv",
        csv: toCsv(violationIssueColumns, lastResult.violationIssues),
      },
      {
        filename: "audit_mismatches.csv",
        csv: toCsv(mismatchColumns, lastResult.dedupedMismatches),
      },
      {
        filename: "prodev_naming_consistency.csv",
        csv: toCsv(prodevConsistencyColumns, lastResult.prodevConsistencyIssues),
      },
      {
        filename: "addons_without_mri.csv",
        csv: toCsv(addOnColumns, lastResult.addOnsWithoutMri),
      },
      {
        filename: "excess_late_cancellations.csv",
        csv: toCsv(lateCancellationColumns, lastResult.excessLateCancellations),
      },
      {
        filename: "no_shows_on_prodev_protocols.csv",
        csv: toCsv(noShowProdevColumns, lastResult.noShowsOnProdevProtocols),
      },
      {
        filename: "fees_on_external_protocols.csv",
        csv: toCsv(externalFeeColumns, lastResult.feesOnExternalProtocols),
      },
      {
        filename: `${TARGET_SCANNER.toLowerCase()}_scanner_events.csv`,
        csv: toCsv(scannerEventColumns, lastResult.scannerEvents),
      },
      {
        filename: "human_mri_external_events.csv",
        csv: toCsv(humanMriExternalColumns, lastResult.humanMriExternalEvents),
      },
    ];
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
    });
    const filename = savedAuditFilename(
      lastRun.dogfishScanRange,
      localDate(now)
    );
    // fflate types its output as a view on any buffer, but it is always a
    // plain ArrayBuffer, which is what Blob accepts.
    const bytes = zip as Uint8Array<ArrayBuffer>;
    downloadBlob(filename, new Blob([bytes], { type: "application/zip" }));
    unsaved = false;
    lastSaved = { filename, at: now };
    refreshSaveStatus();
  });
}
