import Papa from "papaparse";

export type CsvRow = Record<string, string>;

/** Human-readable explanations for PapaParse's error codes, shown to the
 * user instead of (or alongside) its raw technical message. */
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
  /** 0-based index into the returned `rows` array. */
  rowIndex: number;
  /** PapaParse's best-effort parse of the malformed row, if it recovered one. */
  row: CsvRow | undefined;
  /** Plain-English explanation of what's wrong with this row. */
  explanation: string;
}

export interface ParsedCsv {
  rows: CsvRow[];
  /** Rows PapaParse flagged as malformed (e.g. an unescaped quote inside a
   * free-text field). PapaParse still recovers a best-effort row for these,
   * so parsing continues, but callers may want to warn the user. */
  warnings: CsvWarning[];
}

export function parseCsv(text: string): ParsedCsv {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const result = Papa.parse<CsvRow>(withoutBom, {
    header: true,
    skipEmptyLines: true,
  });

  if (result.data.length === 0 && result.errors.length > 0) {
    throw new Error(
      `Failed to parse CSV: ${result.errors[0].message} (row ${result.errors[0].row})`
    );
  }

  const warningsByRow = new Map<number, CsvWarning>();
  for (const error of result.errors) {
    if (error.row === undefined || warningsByRow.has(error.row)) continue;
    warningsByRow.set(error.row, {
      rowIndex: error.row,
      row: result.data[error.row],
      explanation: describeCsvIssue(error.code, error.message),
    });
  }

  return { rows: result.data, warnings: [...warningsByRow.values()] };
}
