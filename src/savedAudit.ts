import { strToU8, zipSync } from "fflate";
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
 *   reports/<one CSV per results table>
 */
export const SAVED_AUDIT_FORMAT = "camris-audit";
export const SAVED_AUDIT_FORMAT_VERSION = 1;

export type AuditInputKey = "dogfish" | "cams" | "redcap";

export const AUDIT_INPUT_KEYS: AuditInputKey[] = ["dogfish", "cams", "redcap"];

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

export interface AuditManifest {
  format: typeof SAVED_AUDIT_FORMAT;
  formatVersion: typeof SAVED_AUDIT_FORMAT_VERSION;
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
