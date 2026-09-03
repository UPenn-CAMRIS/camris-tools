import { buildCamsLookup, classifyIndustry } from "./cams";

export interface ContrastOutputRow {
  date: string;
  event_time: string;
  project: string;
  userid: string;
  specimen: string;
  desc2: string;
  lab: number;
  sublab: number;
  code: string;
  desc1: string;
  quantity: number;
  bill: string;
}

/** A row that passed both filters and would have been billed, but whose
 * "Linked Study IRB Number" could not be classified against CAMS — it is
 * blank, or names a protocol with no CAMS record — so the tool cannot
 * tell whether the billing code should be CAMRIS-003 or CAMRIS-051. The
 * row is left out of the billing output and listed here instead, the
 * same way the Audit Tool reports an event with no CAMS match as a
 * mismatch rather than guessing. */
export interface ContrastMismatchRow {
  date: string;
  event_time: string;
  /** Raw "Linked Study IRB Number" from the Contrast Report; "" when blank. */
  irbNumber: string;
  technologist: string;
  userid: string;
  specimen: string;
  desc2: string;
  /** "Procedure-Related Meds" — the value that made this a billable row. */
  meds: string;
  reason: string;
}

export interface ContrastResult {
  rows: ContrastOutputRow[];
  /** Rows that would have been billed but have no usable CAMS match, so
   * their billing code (CAMRIS-003 vs CAMRIS-051) can't be determined. */
  mismatches: ContrastMismatchRow[];
  /** Contrast_Report rows with a blank "Procedure-Related Meds" value —
   * no contrast medication was given, so the row is not a billable
   * contrast injection. */
  skippedNoMeds: number;
  /** Contrast_Report rows whose Technologist does not appear in the
   * CAMRIS_Technologists list. */
  skippedNoTechMatch: number;
}

function cellString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** A wall-clock date and time, held as plain numbers instead of a JS
 * `Date` — Excel's datetime cells and the CSV export's date text both
 * name a wall-clock time with no time zone of their own, and reading
 * them through `Date`'s local-time getters would silently shift every
 * value by the browser's or server's own time zone offset. */
interface ExamDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Parses "Begin Exam Time". Excel gives this as a native `Date`, which
 * exceljs builds from the serial value using UTC fields — so the UTC
 * getters, not the local ones, recover the wall-clock value Excel
 * shows. A CSV export gives it as text in m/d/Y HH:MM or m/d/yy HH:MM
 * form — a 2-digit year under 100 is read relative to 2000, matching
 * how the source system exports it. */
function parseExamTime(value: unknown): ExamDateTime | undefined {
  if (value instanceof Date) {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
    };
  }

  const text = cellString(value);
  if (text === "") return undefined;

  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})$/.exec(
    text
  );
  if (!match) return undefined;

  const [, monthStr, dayStr, yearStr, hourStr, minuteStr] = match;
  let year = parseInt(yearStr, 10);
  if (year < 2000) year += 2000;

  return {
    year,
    month: parseInt(monthStr, 10),
    day: parseInt(dayStr, 10),
    hour: parseInt(hourStr, 10),
    minute: parseInt(minuteStr, 10),
  };
}

function formatDate(t: ExamDateTime): string {
  const m = String(t.month).padStart(2, "0");
  const d = String(t.day).padStart(2, "0");
  return `${t.year}-${m}-${d}`;
}

function formatTime(t: ExamDateTime): string {
  const h = String(t.hour).padStart(2, "0");
  const m = String(t.minute).padStart(2, "0");
  return `${h}:${m}`;
}

/** Builds the contrast-injection billing rows from Contrast_Report and
 * CAMRIS_Technologists. Keeps only rows with a non-blank
 * "Procedure-Related Meds" value and a Technologist found in the
 * technologist list — the same two filters `Contrast.jl` applies.
 *
 * The billing code is chosen per row from CAMS: a protocol CAMS marks
 * "Industry Sponsored" gets CAMRIS-051, any other CAMS-known protocol
 * gets CAMRIS-003. This is the same industry test the Audit Tool runs
 * (see `classifyIndustry` in ./cams). A kept row whose IRB number is
 * blank or not in CAMS can't be classified, so it is left out of `rows`
 * and reported in `mismatches` instead. */
export function runContrast(
  contrastRows: Record<string, unknown>[],
  technologistRows: Record<string, unknown>[],
  camsRows: Record<string, unknown>[]
): ContrastResult {
  const pennKeyByTechnologist = new Map<string, string>();
  for (const row of technologistRows) {
    const technologist = cellString(row["Technologist"]);
    if (technologist === "") continue;
    pennKeyByTechnologist.set(technologist, cellString(row["PennKey"]));
  }

  const camsLookup = buildCamsLookup(camsRows);

  const rows: ContrastOutputRow[] = [];
  const mismatches: ContrastMismatchRow[] = [];
  let skippedNoMeds = 0;
  let skippedNoTechMatch = 0;

  for (const row of contrastRows) {
    if (cellString(row["Procedure-Related Meds"]) === "") {
      skippedNoMeds++;
      continue;
    }

    const technologist = cellString(row["Technologist"]);
    const userid = pennKeyByTechnologist.get(technologist);
    if (userid === undefined) {
      skippedNoTechMatch++;
      continue;
    }

    const examTime = parseExamTime(row["Begin Exam Time"]);
    const date = examTime ? formatDate(examTime) : "";
    const event_time = examTime ? formatTime(examTime) : "";
    const irbNumber = cellString(row["Linked Study IRB Number"]);
    const specimen = cellString(row["Accession #"]);
    const desc2 = cellString(row["Provider/Resource"]);

    const industry = classifyIndustry(camsLookup, irbNumber);
    if (industry === "unknown") {
      mismatches.push({
        date,
        event_time,
        irbNumber,
        technologist,
        userid,
        specimen,
        desc2,
        meds: cellString(row["Procedure-Related Meds"]),
        reason:
          irbNumber === ""
            ? "Linked Study IRB Number is blank"
            : "No matching protocol in CAMS Data",
      });
      continue;
    }

    rows.push({
      date,
      event_time,
      project: irbNumber,
      userid,
      specimen,
      desc2,
      lab: 7,
      sublab: 0,
      code: industry === "industry" ? "CAMRIS-051" : "CAMRIS-003",
      desc1: "Contrast Injection",
      quantity: 1,
      bill: "Y",
    });
  }

  return { rows, mismatches, skippedNoMeds, skippedNoTechMatch };
}
