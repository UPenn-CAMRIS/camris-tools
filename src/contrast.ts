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

export interface ContrastResult {
  rows: ContrastOutputRow[];
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
 * technologist list — the same two filters `Contrast.jl` applies. */
export function runContrast(
  contrastRows: Record<string, unknown>[],
  technologistRows: Record<string, unknown>[]
): ContrastResult {
  const pennKeyByTechnologist = new Map<string, string>();
  for (const row of technologistRows) {
    const technologist = cellString(row["Technologist"]);
    if (technologist === "") continue;
    pennKeyByTechnologist.set(technologist, cellString(row["PennKey"]));
  }

  const rows: ContrastOutputRow[] = [];
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

    rows.push({
      date: examTime ? formatDate(examTime) : "",
      event_time: examTime ? formatTime(examTime) : "",
      project: cellString(row["Linked Study IRB Number"]),
      userid,
      specimen: cellString(row["Accession #"]),
      desc2: cellString(row["Provider/Resource"]),
      lab: 7,
      sublab: 0,
      code: "CAMRIS-003",
      desc1: "Contrast Injection",
      quantity: 1,
      bill: "Y",
    });
  }

  return { rows, skippedNoMeds, skippedNoTechMatch };
}
