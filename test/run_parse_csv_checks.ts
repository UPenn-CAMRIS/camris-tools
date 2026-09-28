import { strict as assert } from "node:assert";
import { parseCsv, applyRowCorrection } from "../src/parseCsv";

/**
 * Focused checks for applyRowCorrection: replacing one malformed row's
 * raw text and re-parsing the file. The edited text comes from a browser
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

console.log("parse CSV row-correction checks: all assertions passed");
