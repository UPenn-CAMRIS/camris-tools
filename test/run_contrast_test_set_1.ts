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

const contrastBuffer = readFileSync(join(dir, "CAMRIS June Contrast.xlsx"));
const contrastSheet = await parseXlsxBuffer(contrastBuffer);
console.log(
  `Loaded ${contrastSheet.rows.length} Contrast Report rows from xlsx, fields: ${contrastSheet.fields.join(", ")}`
);

const result = runContrast(contrastSheet.rows, technologists.rows);

console.log(
  `\n${result.rows.length} contrast injection rows produced ` +
    `(${result.skippedNoMeds} skipped: no meds, ${result.skippedNoTechMatch} skipped: no technologist match)`
);
console.table(result.rows);
