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

// contrast_test_set_1 has no REDCap or Dogfish export. The Audit Tool's
// test_set_1 exports stand in: REDCap review letters do not depend on
// the month, and the Dogfish events (July) cover no June scan, so every
// row has no Dogfish MRI match.
const auditDir = join(import.meta.dirname, "..", "test_set_1");
const redcap = parseCsv(
  readFileSync(join(auditDir, "Redcap_Export.csv"), "utf-8")
);
const dogfish = parseCsv(
  readFileSync(join(auditDir, "Dogfish_Events.csv"), "utf-8")
);
console.log(
  `Loaded ${redcap.rows.length} REDCap rows and ${dogfish.rows.length} Dogfish rows from test_set_1`
);

const contrastBuffer = readFileSync(join(dir, "CAMRIS June Contrast.xlsx"));
const contrastSheet = await parseXlsxBuffer(contrastBuffer);
console.log(
  `Loaded ${contrastSheet.rows.length} Contrast Report rows from xlsx, fields: ${contrastSheet.fields.join(", ")}`
);

const result = runContrast(
  contrastSheet.rows,
  technologists.rows,
  cams.rows,
  redcap.rows,
  dogfish.rows
);

const byCode = new Map<string, number>();
for (const row of result.rows) {
  const code = row.code || "(no code)";
  byCode.set(code, (byCode.get(code) ?? 0) + 1);
}
const disagree = result.rows.filter(
  (r) => r.saysIndustry.length > 0 && r.saysNotIndustry.length > 0
).length;

console.log(
  `\n${result.rows.length} contrast injection rows produced ` +
    `(${[...byCode].map(([c, n]) => `${n} ${c}`).join(", ") || "none"}), ` +
    `${disagree} with sources that disagree ` +
    `(${result.skippedNoMeds} skipped: no meds, ${result.skippedNoTechMatch} skipped: no technologist match)`
);
console.table(
  result.rows.map((r) => ({
    date: r.date,
    project: r.project,
    code: r.code,
    saysIndustry: r.saysIndustry.join(" + "),
    saysNotIndustry: r.saysNotIndustry.join(" + "),
    noCams: r.noCamsMatch,
    noRedcap: r.noActiveRedcapMatch,
    noFundingType: r.noRedcapFundingType,
    invalidFormat: r.invalidProtocolFormat,
  }))
);

if (result.rows.some((r) => !r.noDogfishMriMatch)) {
  throw new Error("A June contrast row matched a July Dogfish event");
}
