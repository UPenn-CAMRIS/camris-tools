import { strict as assert } from "node:assert";
import {
  parseCsv,
  applyRowCorrection,
  correctedFileText,
  correctedFilename,
  readCsvFile,
} from "../src/parseCsv";

/**
 * Focused checks for applyRowCorrection: replacing one malformed row's
 * raw text and re-parsing the file, then saving the corrected copy. The edited text comes from a browser
 * textarea, which turns every line break into "\n", so these checks pass
 * "\n"-only text the same way the UI does. Run from `npm test`; it throws
 * on the first failed assertion.
 */

/** Parses `text`, then applies `edit` to its only malformed row. */
function correctOnlyWarning(text: string, edit: string) {
  const parsed = parseCsv(text);
  assert.equal(parsed.warnings.length, 1);
  return applyRowCorrection(parsed, parsed.warnings[0].rowIndex, edit);
}

// A "\r\n" file: the edited row's "\n" becomes "\r\n", so the rows after
// it stay separate rows.
{
  const out = correctOnlyWarning(
    'a,b\r\n1,"x"y"\r\n2,z\r\n3,w\r\n',
    '1,"x""y"\n'
  );
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.rows, [
    { a: "1", b: 'x"y' },
    { a: "2", b: "z" },
    { a: "3", b: "w" },
  ]);
  assert.equal(out.rawText, 'a,b\r\n1,"x""y"\r\n2,z\r\n3,w\r\n');
}

// A "\r\n" file where the malformed row swallowed the next line: the
// user fixes the quote and keeps the line break between the two rows.
{
  const parsed = parseCsv('a,b\r\n1,"x\r\n2,z\r\n');
  assert.equal(parsed.rows.length, 1);
  const out = applyRowCorrection(parsed, 0, '1,"x"\n2,z\n');
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.rows, [
    { a: "1", b: "x" },
    { a: "2", b: "z" },
  ]);
  assert.equal(out.rawText, 'a,b\r\n1,"x"\r\n2,z\r\n');
}

// A "\r\n" file: an edit with no trailing line break gets "\r\n".
{
  const out = correctOnlyWarning('a,b\r\n1,"x"y"\r\n2,z\r\n', '1,"x""y"');
  assert.equal(out.rawText, 'a,b\r\n1,"x""y"\r\n2,z\r\n');
}

// A "\n" file is unchanged by the line-ending conversion.
{
  const out = correctOnlyWarning('a,b\n1,"x"y"\n2,z\n', '1,"x""y"\n');
  assert.deepEqual(out.warnings, []);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rawText, 'a,b\n1,"x""y"\n2,z\n');
}

// A file with a byte-order mark: the line ending still comes from the
// header line.
{
  const out = correctOnlyWarning(
    '﻿a,b\r\n1,"x"y"\r\n2,z\r\n',
    '1,"x""y"\n'
  );
  assert.deepEqual(out.warnings, []);
  assert.equal(out.rows.length, 2);
}

// The corrected copy is the uploaded file with only the edited row
// changed: the byte-order mark, the "\r\n" line endings, and the quoting
// of every other row are kept.
{
  const original = '﻿"a",b\r\n1,"x"y"\r\n"2", z \r\n';
  const out = correctOnlyWarning(original, '1,"x""y"\n');
  assert.equal(out.hasBom, true);
  assert.equal(
    correctedFileText(out),
    '﻿"a",b\r\n1,"x""y"\r\n"2", z \r\n'
  );
}

// A file with no byte-order mark does not get one.
{
  const out = correctOnlyWarning('a,b\n1,"x"y"\n', '1,"x""y"\n');
  assert.equal(out.hasBom, false);
  assert.equal(correctedFileText(out), 'a,b\n1,"x""y"\n');
}

// A file as loaded has no corrections; each correction that changes the
// text adds one.
{
  const parsed = parseCsv('a,b\n1,"x"y"\n2,"z"w"\n');
  assert.equal(parsed.correctionCount, 0);
  assert.equal(parsed.warnings.length, 2);
  const once = applyRowCorrection(parsed, 0, '1,"x""y"\n');
  assert.equal(once.correctionCount, 1);
  assert.equal(once.warnings.length, 1);
  const twice = applyRowCorrection(once, 1, '2,"z""w"\n');
  assert.equal(twice.correctionCount, 2);
  assert.deepEqual(twice.warnings, []);
}

// A "correction" that leaves the text the same is not counted.
{
  const parsed = parseCsv('a,b\r\n1,"x"y"\r\n2,z\r\n');
  const unchanged = applyRowCorrection(parsed, 0, '1,"x"y"\n');
  assert.equal(unchanged, parsed);
  assert.equal(unchanged.correctionCount, 0);
}

// The download name adds "-corrected" before the extension.
assert.equal(correctedFilename("CAMS_Data.csv"), "CAMS_Data-corrected.csv");
assert.equal(correctedFilename("Dogfish Events.CSV"), "Dogfish Events-corrected.csv");
assert.equal(correctedFilename("export"), "export-corrected.csv");

// Reading an uploaded file keeps its byte-order mark, which Blob.text()
// would drop, so a corrected copy can put it back.
{
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a,b\n1,2\n")]);
  const withBom = parseCsv(await readCsvFile(new Blob([bytes])));
  assert.equal(withBom.hasBom, true);
  assert.equal(correctedFileText(withBom), "﻿a,b\n1,2\n");
  const withoutBom = parseCsv(await readCsvFile(new Blob(["a,b\n1,2\n"])));
  assert.equal(withoutBom.hasBom, false);
}

console.log("parse CSV row-correction checks: all assertions passed");
