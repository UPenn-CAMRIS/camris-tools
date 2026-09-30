import type { CsvRow } from "./parseCsv";
import {
  buildCamsLookup,
  classifyIndustry,
  normalizeDogfishCamsProtocol,
} from "./cams";
import {
  buildDogfishEvents,
  buildRedcapLookup,
  hasMriService,
  isMriService,
  isValidProtocolFormat,
  mriServiceIndustry,
  type DogfishEvent,
} from "./audit";

/** The contrast-injection billing codes: the standard rate, and the
 * industry rate. */
export const STANDARD_CODE = "CAMRIS-003";
export const INDUSTRY_CODE = "CAMRIS-051";
export const CONTRAST_CODES = [STANDARD_CODE, INDUSTRY_CODE] as const;
export type ContrastCode = (typeof CONTRAST_CODES)[number];

/** A source that can say whether a row's protocol is industry sponsored:
 * the MRI rate Dogfish billed for the scan, CAMS, and REDCap. The order
 * here is the order a tie between two sources is broken in: the first
 * source that has an answer wins. */
export const INDUSTRY_SOURCES = ["MRI service", "CAMS", "REDCap"] as const;
export type IndustrySource = (typeof INDUSTRY_SOURCES)[number];

/** One billable contrast injection: a Contrast Report row with a
 * "Procedure-Related Meds" value and a technologist in the CAMRIS
 * Technologists list. The billing-file fields come first, then what each
 * source says about industry sponsorship and the mismatch flags, which
 * are on screen but not in the billing file. */
export interface ContrastRow {
  date: string;
  event_time: string;
  /** Raw "Linked Study IRB Number"; "" when blank. */
  project: string;
  userid: string;
  specimen: string;
  desc2: string;
  lab: number;
  sublab: number;
  /** The code to bill. It starts as `suggestedCode`, and the page sets
   * it when a person picks a different one. "" means no code yet: the
   * row cannot go in the billing file until one is picked. */
  code: ContrastCode | "";
  desc1: string;
  quantity: number;
  bill: string;
  /** The code the sources point to (see `suggestCode`), or "" when no
   * source has an answer. */
  suggestedCode: ContrastCode | "";
  technologist: string;
  /** "Procedure-Related Meds": the value that made this a billable row. */
  meds: string;
  /** The Dogfish event matched to this scan (see `matchMriEvent`), or ""
   * when none matched. */
  dogfishEventId: string;
  /** The MRI services billed on the matched Dogfish event, joined with
   * " + "; "" when none matched. */
  mriService: string;
  /** The sources that say the protocol is industry sponsored. */
  saysIndustry: IndustrySource[];
  /** The sources that say it is not. A source with no answer is in
   * neither list. */
  saysNotIndustry: IndustrySource[];
  /** REDCap marks the study as CHOP (pi_school 4). */
  chop: boolean;
  noDogfishMriMatch: boolean;
  noCamsMatch: boolean;
  noActiveRedcapMatch: boolean;
  /** The protocol has an active REDCap record, but its funding type is
   * blank, so REDCap cannot say whether it is industry sponsored. */
  noRedcapFundingType: boolean;
  invalidProtocolFormat: boolean;
}

export interface ContrastResult {
  rows: ContrastRow[];
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

// A Dogfish Scan Time: "YYYY-MM-DD HH:MM:SS". The time may be missing.
const DOGFISH_SCAN_TIME = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/;

/** An MRI event in Dogfish, indexed for matching to contrast rows. */
interface MriEvent {
  event: DogfishEvent;
  /** Minutes after midnight, or undefined when Scan Time has no time. */
  minutes: number | undefined;
}

/** Indexes the Dogfish events that billed an MRI service by normalized
 * protocol number and scan date, "protocol\u0000YYYY-MM-DD". */
function indexMriEvents(dogfishRows: CsvRow[]): Map<string, MriEvent[]> {
  const index = new Map<string, MriEvent[]>();
  for (const event of buildDogfishEvents(dogfishRows)) {
    if (!hasMriService(event.flags)) continue;
    const match = DOGFISH_SCAN_TIME.exec(event.scanTime);
    if (!match) continue;
    const [, date, hour, minute] = match;
    const key = mriEventKey(event.protocolNumberRaw, date);
    const minutes =
      hour === undefined
        ? undefined
        : parseInt(hour, 10) * 60 + parseInt(minute, 10);
    const list = index.get(key);
    if (list) list.push({ event, minutes });
    else index.set(key, [{ event, minutes }]);
  }
  return index;
}

function mriEventKey(rawProtocolNumber: string, date: string): string {
  return `${normalizeDogfishCamsProtocol(rawProtocolNumber)}\u0000${date}`;
}

/** The Dogfish MRI event for a contrast row's scan. The Contrast Report
 * has no Event ID, so the match is by protocol and time: an MRI event on
 * the same normalized protocol number and the same date, with the Scan
 * Time nearest to Begin Exam Time. Scan Time is the booked start of the
 * slot, so it can differ from Begin Exam Time by some minutes. With two
 * events equally near, the earlier Scan Time wins, then the lower Event
 * ID. Undefined when the row has no IRB number or no exam time, or no
 * event matches. */
function matchMriEvent(
  index: Map<string, MriEvent[]>,
  irbNumber: string,
  examTime: ExamDateTime | undefined
): DogfishEvent | undefined {
  if (irbNumber === "" || examTime === undefined) return undefined;
  const candidates = index.get(mriEventKey(irbNumber, formatDate(examTime)));
  if (!candidates) return undefined;

  const examMinutes = examTime.hour * 60 + examTime.minute;
  const distance = (e: MriEvent) =>
    e.minutes === undefined ? Infinity : Math.abs(e.minutes - examMinutes);
  return [...candidates].sort(
    (a, b) =>
      distance(a) - distance(b) ||
      a.event.scanTime.localeCompare(b.event.scanTime) ||
      a.event.eventId.localeCompare(b.event.eventId, undefined, {
        numeric: true,
      })
  )[0].event;
}

/** The code the sources point to. Each answer is whether one source says
 * the protocol is industry sponsored, or undefined when it has no
 * answer, in INDUSTRY_SOURCES order. The majority of the sources that
 * answer wins. A tie (one source each way) goes to the first source in
 * INDUSTRY_SOURCES order that answers: the MRI service, then CAMS.
 * With no answer at all, there is no suggestion. */
export function suggestCode(
  answers: readonly (boolean | undefined)[]
): ContrastCode | "" {
  const industry = answers.filter((a) => a === true).length;
  const notIndustry = answers.filter((a) => a === false).length;
  const winner =
    industry !== notIndustry
      ? industry > notIndustry
      : answers.find((a) => a !== undefined);
  if (winner === undefined) return "";
  return winner ? INDUSTRY_CODE : STANDARD_CODE;
}

/** Builds the contrast-injection billing rows from Contrast_Report and
 * CAMRIS_Technologists. Keeps only rows with a non-blank
 * "Procedure-Related Meds" value and a Technologist found in the
 * technologist list — the same two filters `Contrast.jl` applies.
 *
 * The billing code is CAMRIS-051 for an industry-sponsored protocol and
 * CAMRIS-003 otherwise. Three sources say whether a protocol is industry
 * sponsored, each read the way the Audit Tool reads it: the MRI rate
 * Dogfish billed for the same scan (`mriServiceIndustry` in ./audit),
 * CAMS (`classifyIndustry` in ./cams), and REDCap's funding type
 * (`buildRedcapLookup` in ./audit). The row's suggested code is the one
 * the sources point to (see `suggestCode`). A CHOP study that is not
 * industry sponsored gets CAMRIS-003: CHOP studies pay the standard
 * ancillary fees, as they do for the Stimulus and Reader fees.
 *
 * Every row carries the audit's mismatch flags (no CAMS match, no active
 * REDCap match, no REDCap funding type, invalid protocol format), plus
 * one for no matching Dogfish MRI event. */
export function runContrast(
  contrastRows: Record<string, unknown>[],
  technologistRows: Record<string, unknown>[],
  camsRows: Record<string, unknown>[],
  redcapRows: CsvRow[],
  dogfishRows: CsvRow[]
): ContrastResult {
  const pennKeyByTechnologist = new Map<string, string>();
  for (const row of technologistRows) {
    const technologist = cellString(row["Technologist"]);
    if (technologist === "") continue;
    pennKeyByTechnologist.set(technologist, cellString(row["PennKey"]));
  }

  const camsLookup = buildCamsLookup(camsRows);
  const { lookup: redcapLookup } = buildRedcapLookup(redcapRows);
  const mriEvents = indexMriEvents(dogfishRows);

  const rows: ContrastRow[] = [];
  let skippedNoMeds = 0;
  let skippedNoTechMatch = 0;

  for (const row of contrastRows) {
    const meds = cellString(row["Procedure-Related Meds"]);
    if (meds === "") {
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
    const irbNumber = cellString(row["Linked Study IRB Number"]);

    const cams = classifyIndustry(camsLookup, irbNumber);
    const redcap = redcapLookup.get(normalizeDogfishCamsProtocol(irbNumber));
    const chop = redcap?.chop === true;
    const mriEvent = matchMriEvent(mriEvents, irbNumber, examTime);

    const answers: Record<IndustrySource, boolean | undefined> = {
      "MRI service": mriEvent && mriServiceIndustry(mriEvent.flags, chop),
      CAMS: cams === "unknown" ? undefined : cams === "industry",
      REDCap: redcap?.industry,
    };
    const suggestedCode = suggestCode(
      INDUSTRY_SOURCES.map((source) => answers[source])
    );

    rows.push({
      date: examTime ? formatDate(examTime) : "",
      event_time: examTime ? formatTime(examTime) : "",
      project: irbNumber,
      userid,
      specimen: cellString(row["Accession #"]),
      desc2: cellString(row["Provider/Resource"]),
      lab: 7,
      sublab: 0,
      code: suggestedCode,
      desc1: "Contrast Injection",
      quantity: 1,
      bill: "Y",
      suggestedCode,
      technologist,
      meds,
      dogfishEventId: mriEvent?.eventId ?? "",
      mriService: mriEvent
        ? mriEvent.services.filter(isMriService).join(" + ")
        : "",
      saysIndustry: INDUSTRY_SOURCES.filter((s) => answers[s] === true),
      saysNotIndustry: INDUSTRY_SOURCES.filter((s) => answers[s] === false),
      chop,
      noDogfishMriMatch: !mriEvent,
      noCamsMatch: cams === "unknown",
      noActiveRedcapMatch: !redcap,
      noRedcapFundingType: redcap !== undefined && redcap.industry === undefined,
      invalidProtocolFormat: !isValidProtocolFormat(irbNumber),
    });
  }

  return { rows, skippedNoMeds, skippedNoTechMatch };
}
