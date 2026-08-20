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
  let cursor = headerLineEnd(rawText);

  Papa.parse<CsvRow>(rawText, {
    header: true,
    skipEmptyLines: true,
    step: (results) => {
      const rowIndex = rows.length;
      rows.push(results.data);
      rowSpans.push({ start: cursor, end: results.meta.cursor });
      cursor = results.meta.cursor;

      if (results.errors.length > 0) {
        warnings.push({
          rowIndex,
          explanation: describeCsvIssue(
            results.errors[0].code,
            results.errors[0].message
          ),
        });
      }
    },
  });

  return { rows, warnings, rawText, rowSpans };
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
