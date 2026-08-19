import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../src/parseCsv";
import { runAudit } from "../src/audit";

const dir = join(import.meta.dirname, "..", "test_set_1");

const dogfish = parseCsv(readFileSync(join(dir, "Dogfish_Events.csv"), "utf-8"));
const cams = parseCsv(readFileSync(join(dir, "CAMS_Data.csv"), "utf-8"));
const redcap = parseCsv(readFileSync(join(dir, "Redcap_Export.csv"), "utf-8"));

console.log(
  `Loaded ${dogfish.rows.length} Dogfish rows (${dogfish.warningRowCount} warnings), ` +
    `${cams.rows.length} CAMS rows (${cams.warningRowCount} warnings), ` +
    `${redcap.rows.length} RedCap rows (${redcap.warningRowCount} warnings)`
);

const { violations, dedupedViolations, mismatches, scannerEvents, addOnsWithoutMri } =
  runAudit(dogfish.rows, cams.rows, redcap.rows);

console.log(`\n${violations.length} violation rows (per event)`);
console.table(violations.slice(0, 20));

console.log(`\n${dedupedViolations.length} deduped violation rows (per protocol)`);
console.table(dedupedViolations.slice(0, 20));

const violationCounts: Record<string, number> = {};
for (const v of violations) {
  for (const [key, value] of Object.entries(v)) {
    if (value === true) violationCounts[key] = (violationCounts[key] ?? 0) + 1;
  }
}
console.log("Violation counts by type:", violationCounts);

console.log(`\n${mismatches.length} mismatch rows`);
console.table(mismatches.slice(0, 20));

const mismatchCounts = {
  noCamsMatch: mismatches.filter((m) => m.noCamsMatch).length,
  noActiveRedcapMatch: mismatches.filter((m) => m.noActiveRedcapMatch).length,
  invalidProtocolFormat: mismatches.filter((m) => m.invalidProtocolFormat)
    .length,
};
console.log("Mismatch counts by type:", mismatchCounts);

console.log(`\n${scannerEvents.length} SC7T scanner events (incl. no-shows)`);
console.table(scannerEvents.slice(0, 20));

console.log(`\n${addOnsWithoutMri.length} add-on fees billed without an MRI service`);
console.table(addOnsWithoutMri);
