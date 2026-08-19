export interface Column<T> {
  header: string;
  get: (row: T) => string | boolean;
  /** When true, this column's cell content can wrap onto multiple lines
   * instead of staying on one line. Useful for long free-text values,
   * such as a project title. */
  wrap?: boolean;
}

function csvField(value: string | boolean): string {
  const s = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : value;
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  const lines = [columns.map((c) => csvField(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(c.get(row))).join(","));
  }
  return lines.join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
