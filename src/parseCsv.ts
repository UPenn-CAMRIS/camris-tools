import Papa from "papaparse";

export type CsvRow = Record<string, string>;

export interface ParsedCsv {
  rows: CsvRow[];
  /** Rows PapaParse flagged as malformed (e.g. an unescaped quote inside a
   * free-text field). PapaParse still recovers a best-effort row for these,
   * so parsing continues, but callers may want to warn the user. */
  warningRowCount: number;
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

  const warningRows = new Set(result.errors.map((e) => e.row));
  return { rows: result.data, warningRowCount: warningRows.size };
}
