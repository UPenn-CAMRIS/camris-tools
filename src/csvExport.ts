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
  /** An action on screen, such as a remove button, not data: the CSV
   * export leaves the column out. */
  screenOnly?: boolean;
  /** When this returns false, the column is left out, both on screen and
   * in the CSV export, so the two still match. */
  shown?: () => boolean;
}

/** The columns `shown` does not leave out. */
export function shownColumns<T>(columns: Column<T>[]): Column<T>[] {
  return columns.filter((c) => c.shown?.() ?? true);
}

/** A cell value as the CSV export writes it. */
export function csvField(value: string | boolean): string {
  return typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : value;
}

export function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  const data = shownColumns(columns).filter((c) => !c.screenOnly);
  return Papa.unparse({
    fields: data.map((c) => c.header),
    data: rows.map((row) => data.map((c) => csvField(c.get(row)))),
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
