import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../src/parseCsv";
import { parseXlsxBuffer } from "../src/parseXlsx";
import { runContrast } from "../src/contrast";

const dir = join(import.meta.dirname, "..", "contrast_test_set_1");

const technologists = parseCsv(
  readFileSync(join(dir, "CAMRIS_Technologists.csv"), "utf-8")
);
console.log(
  `Loaded ${technologists.rows.length} technologist rows (${technologists.warnings.length} warnings)`
);

const cams = parseCsv(readFileSync(join(dir, "CAMS_Data.csv"), "utf-8"));
console.log(
  `Loaded ${cams.rows.length} CAMS rows (${cams.warnings.length} warnings)`
);

const contrastBuffer = readFileSync(join(dir, "CAMRIS June Contrast.xlsx"));
const contrastSheet = await parseXlsxBuffer(contrastBuffer);
console.log(
  `Loaded ${contrastSheet.rows.length} Contrast Report rows from xlsx, fields: ${contrastSheet.fields.join(", ")}`
);

const result = runContrast(contrastSheet.rows, technologists.rows, cams.rows);

const byCode = new Map<string, number>();
for (const row of result.rows) {
  byCode.set(row.code, (byCode.get(row.code) ?? 0) + 1);
}

console.log(
  `\n${result.rows.length} contrast injection rows produced ` +
    `(${[...byCode].map(([c, n]) => `${n} ${c}`).join(", ") || "none"}), ` +
    `${result.mismatches.length} mismatch rows ` +
    `(${result.skippedNoMeds} skipped: no meds, ${result.skippedNoTechMatch} skipped: no technologist match)`
);
console.table(result.rows);

console.log(`\n${result.mismatches.length} rows with no usable CAMS match:`);
console.table(result.mismatches);
