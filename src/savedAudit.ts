import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from "fflate";
import { DECISION_TABLE_LABELS, type DecisionTableId } from "./decisions";
import type { CsvRow, RowCorrection } from "./parseCsv";

/** A saved audit is one zip file holding everything needed to open the
 * audit again: the three input files exactly as uploaded, the row
 * corrections made to them in the browser, every results table as CSV
 * (with the decisions), and a manifest describing the audit.
 *
 *   manifest.json
 *   inputs/dogfish/<uploaded file name>
 *   inputs/cams/<uploaded file name>
 *   inputs/redcap/<uploaded file name>
 *   reports/<one CSV per results table, and the earlier decisions>
 *   previous/reports/<the previous audit's decision CSVs>
 *
 * previous/ is there only for an audit started with a previous audit for
 * reference. It holds what this audit needs of it, so opening this audit
 * again does not need the previous one's file.
 */
export const SAVED_AUDIT_FORMAT = "camris-audit";
/** 2 added the previous audit, the Since Previous Audit column (headed
 * "This Audit" in files saved before it was renamed; nothing reads it
 * back), the Confirmed By column, and the earlier-decisions CSV. This
 * version opens files of versions 1 and 2. */
export const SAVED_AUDIT_FORMAT_VERSION = 2;

export type AuditInputKey = "dogfish" | "cams" | "redcap";

export const AUDIT_INPUT_KEYS: AuditInputKey[] = ["dogfish", "cams", "redcap"];

/** The CSV file, in reports/, of each table that takes decisions. Opening
 * a saved audit reads the decisions back from these files. */
export const DECISION_REPORT_FILES: Record<DecisionTableId, string> = {
  protocolIssues: "audit_violations_by_protocol.csv",
  mismatches: "audit_mismatches.csv",
  prodevConsistency: "prodev_naming_consistency.csv",
  humanMriExternal: "human_mri_external_events.csv",
};

/** The CSV file, in reports/, of the Earlier Decisions Not Flagged table:
 * decisions carried from earlier audits whose rows this audit does not
 * flag. */
export const EARLIER_DECISIONS_FILE = "earlier_decisions_not_flagged.csv";

/** The CSV files of a previous audit that the next audit reads: the four
 * decision tables and the earlier decisions. A version-1 file has no
 * earlier decisions. */
export const PREVIOUS_AUDIT_FILES = [
  ...Object.values(DECISION_REPORT_FILES),
  EARLIER_DECISIONS_FILE,
];

/** The most a saved audit may hold once unpacked. A month of exports is a
 * few MB; the limit stops a damaged or wrong file from hanging the page. */
export const MAX_SAVED_AUDIT_BYTES = 200 * 1024 * 1024;

/** The earliest and latest Dogfish Scan Time, compared as text. */
export interface ScanRange {
  first: string;
  last: string;
}

export interface SavedInput {
  /** The file's path inside the zip. */
  file: string;
  /** The file's name when it was uploaded. */
  filename: string;
  /** The row corrections made in the browser, in the order they were
   * applied. Applying them again, in order, to the file as uploaded
   * gives the text the audit ran on. */
  corrections: RowCorrection[];
}

/** An earlier decision that a reviewer removed from this audit, so it is
 * not carried into later audits. */
export interface RemovedDecision {
  table: DecisionTableId;
  /** The key columns' text, in the order of DECISION_KEY_COLUMNS. */
  keyCells: string[];
}

/** The previous audit an audit was started with, for reference. */
export interface PreviousAuditRecord {
  auditId: string;
  savedAt: string;
  savedBy: string;
  dogfishScanRange: ScanRange | null;
  /** Earlier decisions removed in this audit. */
  removedDecisions: RemovedDecision[];
}

export interface AuditManifest {
  format: typeof SAVED_AUDIT_FORMAT;
  formatVersion: 1 | 2;
  /** Stays the same each time the same audit is saved again. */
  auditId: string;
  /** When the audit was first run, as local time with its UTC offset. */
  createdAt: string;
  /** When this file was saved, as local time with its UTC offset. */
  savedAt: string;
  /** The initials entered when this file was saved. */
  savedBy: string;
  /** The app build (git commit) that saved this file. */
  appVersion: string;
  /** null when no Dogfish row has a Scan Time. */
  dogfishScanRange: ScanRange | null;
  inputs: Record<AuditInputKey, SavedInput>;
  /** The results tables' CSV files, as paths inside the zip. */
  reports: string[];
  /** null for an audit started without a previous audit, and in a
   * version-1 file. */
  previousAudit: PreviousAuditRecord | null;
}

export interface AuditInputFile {
  filename: string;
  /** The file exactly as uploaded. */
  bytes: Uint8Array;
  corrections: RowCorrection[];
}

export interface ReportFile {
  /** The CSV's file name, for example "audit_mismatches.csv". */
  filename: string;
  csv: string;
}

export interface SavedAuditDetails {
  auditId: string;
  createdAt: string;
  savedAt: string;
  savedBy: string;
  appVersion: string;
  dogfishScanRange: ScanRange | null;
  inputs: Record<AuditInputKey, AuditInputFile>;
  reports: ReportFile[];
  /** The previous audit, with its CSV files as PREVIOUS_AUDIT_FILES names
   * them; null when there is none. */
  previous: { record: PreviousAuditRecord; reports: ReportFile[] } | null;
}

/** A file name cannot add folders inside the zip. */
function safeName(filename: string): string {
  return filename.replace(/[/\\]/g, "_") || "file";
}

/** Builds the saved-audit zip, and the manifest inside it. */
export function buildSavedAudit(details: SavedAuditDetails): {
  manifest: AuditManifest;
  zip: Uint8Array;
} {
  const files: Record<string, Uint8Array> = {};

  const inputs = {} as Record<AuditInputKey, SavedInput>;
  for (const key of AUDIT_INPUT_KEYS) {
    const input = details.inputs[key];
    const file = `inputs/${key}/${safeName(input.filename)}`;
    files[file] = input.bytes;
    inputs[key] = {
      file,
      filename: input.filename,
      corrections: input.corrections,
    };
  }

  const reports: string[] = [];
  for (const report of details.reports) {
    const file = `reports/${safeName(report.filename)}`;
    files[file] = strToU8(report.csv);
    reports.push(file);
  }
  for (const report of details.previous?.reports ?? []) {
    files[`previous/reports/${safeName(report.filename)}`] = strToU8(report.csv);
  }

  const manifest: AuditManifest = {
    format: SAVED_AUDIT_FORMAT,
    formatVersion: SAVED_AUDIT_FORMAT_VERSION,
    auditId: details.auditId,
    createdAt: details.createdAt,
    savedAt: details.savedAt,
    savedBy: details.savedBy,
    appVersion: details.appVersion,
    dogfishScanRange: details.dogfishScanRange,
    inputs,
    reports,
    previousAudit: details.previous?.record ?? null,
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2) + "\n");

  return { manifest, zip: zipSync(files) };
}

/** The saved audit's download name: the Dogfish scan period it covers,
 * then the date it was saved. For example
 * "camris_audit_2026-09-01_to_2026-09-29_saved_2026-09-30.zip". */
export function savedAuditFilename(
  range: ScanRange | null,
  savedOn: string
): string {
  const period = range
    ? `${range.first.slice(0, 10)}_to_${range.last.slice(0, 10)}_`
    : "";
  return safeName(`camris_audit_${period}saved_${savedOn}.zip`);
}

/** The earliest and latest non-blank Dogfish "Scan Time", compared as
 * text, the same way the Violations by Protocol table compares them. */
export function scanTimeRange(dogfishRows: CsvRow[]): ScanRange | null {
  let range: ScanRange | null = null;
  for (const row of dogfishRows) {
    const time = (row["Scan Time"] ?? "").trim();
    if (time === "") continue;
    if (!range) range = { first: time, last: time };
    else {
      if (time < range.first) range.first = time;
      if (time > range.last) range.last = time;
    }
  }
  return range;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** The local date of `date`, "YYYY-MM-DD". */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `date` as local time with its UTC offset, for example
 * "2026-09-30T14:12:05-04:00". */
export function localTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** A random version-4 UUID. Built from crypto.getRandomValues, which,
 * unlike crypto.randomUUID, does not need a secure context. */
export function newAuditId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    ""
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A saved audit, read back from its zip. */
export interface OpenedAudit {
  manifest: AuditManifest;
  inputs: Record<AuditInputKey, AuditInputFile>;
  /** Each report CSV's text, by its file name without "reports/". */
  reports: Map<string, string>;
  /** The previous audit this audit was started with, and its CSV files'
   * text by file name without "previous/reports/"; null when none. */
  previous: { record: PreviousAuditRecord; reports: Map<string, string> } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScanRange(value: unknown): value is ScanRange | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.first === "string" &&
      typeof value.last === "string")
  );
}

function isRemovedDecision(value: unknown): value is RemovedDecision {
  return (
    isRecord(value) &&
    typeof value.table === "string" &&
    value.table in DECISION_TABLE_LABELS &&
    Array.isArray(value.keyCells) &&
    value.keyCells.every((cell) => typeof cell === "string")
  );
}

function isPreviousAuditRecord(value: unknown): value is PreviousAuditRecord {
  return (
    isRecord(value) &&
    typeof value.auditId === "string" &&
    typeof value.savedAt === "string" &&
    typeof value.savedBy === "string" &&
    isScanRange(value.dogfishScanRange) &&
    Array.isArray(value.removedDecisions) &&
    value.removedDecisions.every(isRemovedDecision)
  );
}

function isCorrection(value: unknown): value is RowCorrection {
  return (
    isRecord(value) &&
    Number.isInteger(value.rowIndex) &&
    typeof value.text === "string"
  );
}

/** Reads a saved-audit zip. Throws an Error with a plain-English message
 * when the file is not a saved audit, was saved by a newer version of the
 * tool, or is missing a part. */
export function openSavedAudit(zip: Uint8Array): OpenedAudit {
  const notSavedAudit = (why: string) =>
    new Error(`This file is not a saved audit: ${why}`);

  let unpackedSize = 0;
  let tooLarge = false;
  let files: Unzipped;
  try {
    files = unzipSync(zip, {
      filter: (file) => {
        unpackedSize += file.originalSize;
        if (unpackedSize > MAX_SAVED_AUDIT_BYTES) tooLarge = true;
        return !tooLarge;
      },
    });
  } catch {
    throw notSavedAudit("it could not be read as a zip file.");
  }
  if (tooLarge) {
    throw notSavedAudit(
      `it unpacks to more than ${MAX_SAVED_AUDIT_BYTES / (1024 * 1024)} MB.`
    );
  }

  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw notSavedAudit("it has no manifest.json.");
  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw notSavedAudit("its manifest.json could not be read.");
  }
  if (!isRecord(manifest) || manifest.format !== SAVED_AUDIT_FORMAT) {
    throw notSavedAudit("its manifest.json is not a CAMRIS audit manifest.");
  }
  if (
    typeof manifest.formatVersion === "number" &&
    manifest.formatVersion > SAVED_AUDIT_FORMAT_VERSION
  ) {
    throw new Error(
      "This audit was saved by a newer version of the tool. Reload the page to get the latest version, then open it again."
    );
  }
  if (manifest.formatVersion !== 1 && manifest.formatVersion !== 2) {
    throw notSavedAudit("its manifest.json has an unknown format version.");
  }
  for (const field of ["auditId", "createdAt", "savedAt", "savedBy", "appVersion"]) {
    if (typeof manifest[field] !== "string") {
      throw notSavedAudit(`its manifest.json has no ${field}.`);
    }
  }

  const inputs = {} as Record<AuditInputKey, AuditInputFile>;
  const manifestInputs = isRecord(manifest.inputs) ? manifest.inputs : {};
  for (const key of AUDIT_INPUT_KEYS) {
    const input = manifestInputs[key];
    if (
      !isRecord(input) ||
      typeof input.file !== "string" ||
      typeof input.filename !== "string" ||
      !Array.isArray(input.corrections) ||
      !input.corrections.every(isCorrection)
    ) {
      throw notSavedAudit(`its manifest.json does not describe the ${key} input.`);
    }
    const bytes = files[input.file];
    if (!bytes) throw notSavedAudit(`it is missing ${input.file}.`);
    inputs[key] = {
      filename: input.filename,
      bytes,
      corrections: input.corrections,
    };
  }

  const reports = new Map<string, string>();
  for (const [path, bytes] of Object.entries(files)) {
    if (path.startsWith("reports/")) {
      reports.set(path.slice("reports/".length), strFromU8(bytes));
    }
  }

  let previous: OpenedAudit["previous"] = null;
  const previousRecord = manifest.previousAudit ?? null;
  if (previousRecord !== null) {
    if (!isPreviousAuditRecord(previousRecord)) {
      throw notSavedAudit("its manifest.json does not describe its previous audit.");
    }
    const previousReports = new Map<string, string>();
    for (const [path, bytes] of Object.entries(files)) {
      if (path.startsWith("previous/reports/")) {
        previousReports.set(path.slice("previous/reports/".length), strFromU8(bytes));
      }
    }
    previous = { record: previousRecord, reports: previousReports };
  }

  return {
    manifest: { ...manifest, previousAudit: previousRecord } as unknown as AuditManifest,
    inputs,
    reports,
    previous,
  };
}
