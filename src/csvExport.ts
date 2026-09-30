import Papa from "papaparse";

export interface Column<T> {
  header: string;
  get: (row: T) => string | boolean;
  /** When true, this column's cell content can wrap onto multiple lines
   * instead of staying on one line. Useful for long free-text values,
   * such as a project title. */
  wrap?: boolean;
  /** Builds this column's cell content on screen, in place of the text
   * from `get`, for a cell the user can edit. `get` still gives the
   * value for the CSV export. */
  render?: (row: T) => Node;
}

/** A cell value as the CSV export writes it. */
export function csvField(value: string | boolean): string {
  return typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : value;
}

export function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  return Papa.unparse({
    fields: columns.map((c) => c.header),
    data: rows.map((row) => columns.map((c) => csvField(c.get(row)))),
  });
}

export function downloadCsv(filename: string, csv: string): void {
  downloadBlob(filename, new Blob([csv], { type: "text/csv;charset=utf-8;" }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
