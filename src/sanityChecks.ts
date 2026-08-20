import { SERVICE_MAP, NO_SHOW_SERVICE } from "./audit";

/** The minimum shape a sanity check needs: column names and rows keyed
 * by column name. `ParsedCsv` satisfies this. So does a sheet read from
 * an Excel file, which has no CSV-specific concepts like warnings or
 * raw text. */
export interface TabularData {
  fields: string[];
  rows: Record<string, unknown>[];
}

/** A required column that is missing, or present under a slightly
 * different name. `actualHeader` is set only for the "different name"
 * case — a case or whitespace difference from `expected`. */
export interface ColumnIssue {
  expected: string;
  actualHeader: string | undefined;
}

/** A value found in a coded column that is outside the column's known
 * set, and how many rows use it. */
export interface ValueIssue {
  column: string;
  value: string;
  count: number;
}

export interface SanityCheckResult {
  /** Required columns with no matching header at all. Blocks the audit. */
  missingColumns: ColumnIssue[];
  /** Required columns whose header is a case/whitespace variant of the
   * expected name. The audit reads such a column as blank everywhere,
   * the same as a missing column, so this also blocks the audit. */
  renamedColumns: ColumnIssue[];
  /** Values found outside a column's known set. Warns only. */
  unrecognizedValues: ValueIssue[];
  /** True when the file has a header row but no data rows. Warns only. */
  isEmpty: boolean;
}

export function hasBlockingIssues(result: SanityCheckResult): boolean {
  return result.missingColumns.length > 0 || result.renamedColumns.length > 0;
}

interface CodedColumnCheck {
  column: string;
  knownValues: Set<string>;
}

export interface FileSchema {
  requiredColumns: string[];
  codedColumns: CodedColumnCheck[];
}

const DOGFISH_SCHEMA: FileSchema = {
  requiredColumns: [
    "Event ID",
    "Protocol Number",
    "Protocol Type",
    "Project Title",
    "Scan Time",
    "Scanner",
    "Service",
    "Quantity",
    "Mandatory Service",
    "Scheduling User",
    "Check-In User",
  ],
  codedColumns: [
    {
      column: "Service",
      knownValues: new Set([...Object.keys(SERVICE_MAP), NO_SHOW_SERVICE]),
    },
  ],
};

const CAMS_SCHEMA: FileSchema = {
  requiredColumns: ["Protocol Number", "Industry Sponsored"],
  codedColumns: [
    {
      column: "Industry Sponsored",
      // The audit only checks for "Yes" (see audit.ts), so "Not
      // Reported" already reads as not-industry-sponsored, the same
      // as "No" — it is a legitimate value, not a data problem.
      knownValues: new Set(["Yes", "No", "Not Reported", ""]),
    },
  ],
};

const REDCAP_SCHEMA: FileSchema = {
  requiredColumns: [
    "irb_protocol_number",
    "camris_review_letter_complete",
    "fees_reviewletter___2",
    "fees_reviewletter___6",
  ],
  codedColumns: [
    {
      column: "camris_review_letter_complete",
      knownValues: new Set(["0", "1", "2", ""]),
    },
    { column: "fees_reviewletter___2", knownValues: new Set(["0", "1", ""]) },
    { column: "fees_reviewletter___6", knownValues: new Set(["0", "1", ""]) },
  ],
};

export const FILE_SCHEMAS = {
  dogfish: DOGFISH_SCHEMA,
  cams: CAMS_SCHEMA,
  redcap: REDCAP_SCHEMA,
} as const;

const CONTRAST_REPORT_SCHEMA: FileSchema = {
  requiredColumns: [
    "Begin Exam Time",
    "Linked Study IRB Number",
    "Provider/Resource",
    "Procedure-Related Meds",
    "Technologist",
    "Accession #",
  ],
  codedColumns: [],
};

const TECHNOLOGISTS_SCHEMA: FileSchema = {
  requiredColumns: ["Technologist", "PennKey"],
  codedColumns: [],
};

export const CONTRAST_FILE_SCHEMAS = {
  contrastReport: CONTRAST_REPORT_SCHEMA,
  technologists: TECHNOLOGISTS_SCHEMA,
  cams: CAMS_SCHEMA,
} as const;

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function checkColumns(
  requiredColumns: string[],
  actualFields: string[]
): { missing: ColumnIssue[]; renamed: ColumnIssue[] } {
  const missing: ColumnIssue[] = [];
  const renamed: ColumnIssue[] = [];

  const normalizedToActual = new Map<string, string>();
  for (const actual of actualFields) {
    normalizedToActual.set(normalizeHeader(actual), actual);
  }

  for (const expected of requiredColumns) {
    if (actualFields.includes(expected)) continue;
    const near = normalizedToActual.get(normalizeHeader(expected));
    if (near !== undefined) {
      renamed.push({ expected, actualHeader: near });
    } else {
      missing.push({ expected, actualHeader: undefined });
    }
  }

  return { missing, renamed };
}

/** Scans each coded column for values outside its known set. Skips a
 * column that is missing or only a near-match by name, since every
 * value in that column would read as unrecognized for the wrong
 * reason — the real problem is the column name, already reported by
 * checkColumns. */
function checkCodedColumns(
  codedColumns: CodedColumnCheck[],
  availableFields: string[],
  rows: Record<string, unknown>[]
): ValueIssue[] {
  const issues: ValueIssue[] = [];

  for (const { column, knownValues } of codedColumns) {
    if (!availableFields.includes(column)) continue;

    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = String(row[column] ?? "").trim();
      if (knownValues.has(value)) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    for (const [value, count] of counts) {
      issues.push({ column, value, count });
    }
  }

  return issues;
}

export function runSanityChecks(
  schema: FileSchema,
  data: TabularData
): SanityCheckResult {
  const { missing, renamed } = checkColumns(schema.requiredColumns, data.fields);
  return {
    missingColumns: missing,
    renamedColumns: renamed,
    unrecognizedValues: checkCodedColumns(
      schema.codedColumns,
      data.fields,
      data.rows
    ),
    isEmpty: data.rows.length === 0,
  };
}
