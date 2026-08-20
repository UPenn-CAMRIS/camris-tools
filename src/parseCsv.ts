import Papa from "papaparse";

export type CsvRow = Record<string, string>;

/** Plain-English explanations for PapaParse's error codes. The UI shows
 * these instead of, or next to, PapaParse's raw technical message. */
const ISSUE_EXPLANATIONS: Record<string, string> = {
  TooFewFields:
    "This row has fewer columns than the header row — a value may be missing, or a quoted field on an earlier line didn't fully contain a line break.",
  TooManyFields:
    "This row has more columns than the header row — a value probably contains an unescaped comma, shifting the rest of the row over.",
  InvalidQuotes:
    "This row has a quote character that isn't properly escaped inside a field — nearby text may have been parsed incorrectly.",
  MissingQuotes:
    "A quoted field in this row is missing its closing quote — everything after it may have been parsed incorrectly.",
  UndetectableDelimiter:
    "The file's column delimiter couldn't be reliably detected for this row.",
};

function describeCsvIssue(code: string | undefined, message: string): string {
  return (code && ISSUE_EXPLANATIONS[code]) || message;
}

export interface CsvWarning {
  /** 0-based index into the returned `rows` array, and into `rowSpans`. */
  rowIndex: number;
  /** Plain-English explanation of what's wrong with this row. */
  explanation: string;
  /** PapaParse's standardized error code, for building a more specific
   * diagnosis. Undefined for an error PapaParse didn't categorize. */
  code: string | undefined;
  /** Absolute character offset into `ParsedCsv.rawText` where PapaParse
   * lost track of the row, for InvalidQuotes and MissingQuotes errors.
   * PapaParse does not report a position for other error codes. */
  index: number | undefined;
  /** PapaParse's raw, technical error message, before mapping it to the
   * plain-English `explanation`. For TooFewFields/TooManyFields this
   * names the exact field counts, which the mapped explanation drops. */
  rawMessage: string;
}

/** The raw character range in `rawText` that produced one parsed row.
 * A malformed row — for example one with an unescaped quote — can
 * swallow one or more of the physical lines that follow it. In that
 * case, `end` reaches past a single line, into the lines it absorbed. */
export interface RowSpan {
  start: number;
  end: number;
}

export interface ParsedCsv {
  rows: CsvRow[];
  /** Rows PapaParse flagged as malformed, for example a row with an
   * unescaped quote inside a free-text field. PapaParse still recovers a
   * best-effort row for these, so parsing continues. Callers may still
   * want to warn the user. */
  warnings: CsvWarning[];
  /** The exact text that was parsed (BOM stripped), for slicing out raw
   * row text and for rebuilding a corrected copy to re-parse. */
  rawText: string;
  /** One entry per row in `rows`, giving that row's raw text range in
   * `rawText`. */
  rowSpans: RowSpan[];
  /** Column names from the header row. */
  fields: string[];
}

function headerLineEnd(text: string): number {
  const idx = text.indexOf("\n");
  return idx === -1 ? text.length : idx + 1;
}

export function parseCsv(text: string): ParsedCsv {
  const rawText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: CsvRow[] = [];
  const warnings: CsvWarning[] = [];
  const rowSpans: RowSpan[] = [];
  let fields: string[] = [];
  let cursor = headerLineEnd(rawText);

  Papa.parse<CsvRow>(rawText, {
    header: true,
    skipEmptyLines: true,
    step: (results) => {
      const rowIndex = rows.length;
      rows.push(results.data);
      rowSpans.push({ start: cursor, end: results.meta.cursor });
      cursor = results.meta.cursor;
      if (results.meta.fields) fields = results.meta.fields;

      if (results.errors.length > 0) {
        const error = results.errors[0];
        warnings.push({
          rowIndex,
          explanation: describeCsvIssue(error.code, error.message),
          code: error.code,
          index: error.index,
          rawMessage: error.message,
        });
      }
    },
  });

  return { rows, warnings, rawText, rowSpans, fields };
}

/** A specific, best-effort guess at what's wrong with a malformed row,
 * built from PapaParse's error code and (when available) the character
 * position where it lost track of the row. This is a heuristic guess,
 * not a guarantee — PapaParse does not explain malformed CSV, it only
 * reports where it gave up. */
export interface RowDiagnosis {
  message: string;
  /** Character offset into this row's raw text to point out to the
   * user, if PapaParse reported one for this error. */
  highlightOffset: number | undefined;
}

/** PapaParse's `error.index` marks the start of the field it flagged —
 * the character right after that field's opening quote — not the
 * stray quote itself. From there, this walks forward through the
 * field the same way a CSV reader does: a doubled `""` is an escaped
 * literal quote and gets skipped, so the first single, undoubled `"`
 * it reaches is the exact character where the field's quoting broke.
 * Returns undefined if `fieldStart` doesn't actually sit right after
 * an opening quote (so the position can't be trusted), or if the scan
 * reaches the end of the row without finding one. */
function findStrayQuote(
  rawText: string,
  fieldStart: number,
  rowEnd: number
): number | undefined {
  if (rawText[fieldStart - 1] !== '"') return undefined;

  let i = fieldStart;
  while (i < rowEnd) {
    if (rawText[i] === '"') {
      if (rawText[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return undefined;
}

export function diagnoseWarning(
  parsed: ParsedCsv,
  warning: CsvWarning
): RowDiagnosis {
  const span = parsed.rowSpans[warning.rowIndex];

  const fieldCountMatch = /expected (\d+) fields but parsed (\d+)/.exec(
    warning.rawMessage
  );

  switch (warning.code) {
    case "MissingQuotes":
    case "InvalidQuotes": {
      const strayQuote =
        warning.index !== undefined
          ? findStrayQuote(parsed.rawText, warning.index, span.end)
          : undefined;
      const highlightOffset =
        strayQuote !== undefined ? strayQuote - span.start : undefined;
      const located =
        highlightOffset !== undefined
          ? " The stray quote is highlighted below."
          : "";
      return {
        message:
          warning.code === "MissingQuotes"
            ? `A quoted field opens with a double quote but never closes.${located} Inside a quoted field, a literal " must be written as two double quotes ("").`
            : `A double quote inside a quoted field ends it early because it isn't doubled.${located} Inside a quoted field, a literal " must be written as two double quotes ("").`,
        highlightOffset,
      };
    }
    case "TooFewFields": {
      const [, expected, actual] = fieldCountMatch ?? [];
      return {
        message: expected
          ? `This row has ${actual} field(s) but the header has ${expected} — a value is probably missing, or a quoted field on this row absorbed a line break that belonged to the next row.`
          : "This row has fewer fields than the header — a value is probably missing.",
        highlightOffset: undefined,
      };
    }
    case "TooManyFields": {
      const [, expected, actual] = fieldCountMatch ?? [];
      return {
        message: expected
          ? `This row has ${actual} field(s) but the header has ${expected} — a value likely contains a comma that should have been wrapped in double quotes.`
          : "This row has more fields than the header — a value likely contains an unescaped comma.",
        highlightOffset: undefined,
      };
    }
    default:
      return { message: warning.explanation, highlightOffset: undefined };
  }
}

/** Raw text of the row at `rowIndex`, plus the row immediately before and
 * after it, for showing a malformed row in the context it needs to be
 * understood and repaired. `before`/`after` are undefined at the start
 * or end of the file. */
export function rowContext(
  parsed: ParsedCsv,
  rowIndex: number
): { before: string | undefined; current: string; after: string | undefined } {
  const { rawText, rowSpans } = parsed;
  const slice = (span: RowSpan) => rawText.slice(span.start, span.end);
  return {
    before: rowIndex > 0 ? slice(rowSpans[rowIndex - 1]) : undefined,
    current: slice(rowSpans[rowIndex]),
    after:
      rowIndex < rowSpans.length - 1 ? slice(rowSpans[rowIndex + 1]) : undefined,
  };
}

/** Replaces the raw text of the row at `rowIndex` with `correctedText`,
 * then re-parses the whole file. Use this after a user edits a malformed
 * row, since a single row's raw text can run past one physical line —
 * fixing it can only be verified by re-parsing everything after it. */
export function applyRowCorrection(
  parsed: ParsedCsv,
  rowIndex: number,
  correctedText: string
): ParsedCsv {
  const span = parsed.rowSpans[rowIndex];
  const withNewline = correctedText.endsWith("\n")
    ? correctedText
    : correctedText + "\n";
  const rebuilt =
    parsed.rawText.slice(0, span.start) +
    withNewline +
    parsed.rawText.slice(span.end);
  return parseCsv(rebuilt);
}
