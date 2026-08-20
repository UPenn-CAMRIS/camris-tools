import ExcelJS from "exceljs";

/** A worksheet's data, read into the same shape a CSV parse produces:
 * column names from the header row, and one object per data row keyed
 * by those names. Date/time cells come through as JS `Date` objects,
 * not text — Excel stores them as numbers, not formatted strings. */
export interface XlsxSheet {
  fields: string[];
  rows: Record<string, unknown>[];
}

function cellText(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value === "object" && "text" in value) return value.text;
  if (typeof value === "object" && "result" in value) return value.result;
  return value;
}

/** Reads the first worksheet of an .xlsx workbook. Blank cells read as
 * an empty string, matching how a blank CSV field reads. */
export async function parseXlsxBuffer(
  data: ArrayBuffer | Uint8Array
): Promise<XlsxSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { fields: [], rows: [] };

  const headerRow = sheet.getRow(1);
  const fields: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    fields.push(String(cellText(cell.value)));
  });

  const rows: Record<string, unknown>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (row.cellCount === 0) continue;
    const record: Record<string, unknown> = {};
    fields.forEach((field, i) => {
      record[field] = cellText(row.getCell(i + 1).value);
    });
    rows.push(record);
  }

  return { fields, rows };
}

export async function parseXlsxFile(file: File): Promise<XlsxSheet> {
  const buffer = await file.arrayBuffer();
  return parseXlsxBuffer(buffer);
}
