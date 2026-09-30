import { strict as assert } from "node:assert";
import type { Column } from "../src/csvExport";
import { sortedRows, tableSort, toggleSort } from "../src/table";

/**
 * Checks for sorting the results tables by a column: the default sort,
 * toggling A to Z and Z to A, comparing as text, and keeping the order of
 * rows with the same text.
 *
 * Builds the rows inline. Run from `npm test`; it throws on the first
 * failed assertion.
 */

interface Row {
  id: string;
  name: string;
  flag: boolean;
}

const columns: Column<Row>[] = [
  { header: "ID", get: (r) => r.id },
  { header: "Name", get: (r) => r.name },
  { header: "Flag", get: (r) => r.flag },
  { header: "", get: () => "", screenOnly: true },
];

const rows: Row[] = [
  { id: "9", name: "b", flag: true },
  { id: "10", name: "a", flag: false },
  { id: "2", name: "b", flag: false },
  { id: "10", name: "c", flag: true },
];

const ids = (sorted: Row[]) => sorted.map((r) => `${r.id}${r.name}`);

// By default a table is sorted by its first column, A to Z, compared as
// text ("10" before "2" before "9"). Rows with the same text keep their
// order.
assert.deepEqual(tableSort("t1", columns), { header: "ID", descending: false });
assert.deepEqual(ids(sortedRows("t1", columns, rows)), ["10a", "10c", "2b", "9b"]);

// Clicking the same header again sorts Z to A; rows with the same text
// still keep their order.
toggleSort("t1", columns, "ID");
assert.deepEqual(tableSort("t1", columns), { header: "ID", descending: true });
assert.deepEqual(ids(sortedRows("t1", columns, rows)), ["9b", "2b", "10a", "10c"]);

// And back to A to Z.
toggleSort("t1", columns, "ID");
assert.deepEqual(tableSort("t1", columns), { header: "ID", descending: false });

// Clicking another header sorts by it, A to Z.
toggleSort("t1", columns, "Name");
assert.deepEqual(tableSort("t1", columns), { header: "Name", descending: false });
assert.deepEqual(ids(sortedRows("t1", columns, rows)), ["10a", "9b", "2b", "10c"]);

// A boolean column sorts by its CSV text: FALSE before TRUE.
toggleSort("t1", columns, "Flag");
assert.deepEqual(
  sortedRows("t1", columns, rows).map((r) => r.flag),
  [false, false, true, true]
);

// Each table keeps its own sort.
assert.deepEqual(tableSort("t2", columns), { header: "ID", descending: false });

// A screen-only column cannot be the sort, and a sort by a column the
// table no longer has falls back to the first sortable column.
toggleSort("t3", columns, "");
assert.deepEqual(tableSort("t3", columns), { header: "ID", descending: false });
toggleSort("t4", columns, "Name");
assert.deepEqual(tableSort("t4", columns.slice(0, 1)), {
  header: "ID",
  descending: false,
});
assert.deepEqual(
  tableSort("t5", [{ header: "", get: () => "", screenOnly: true }]),
  undefined
);

// A column that is not shown cannot be the sort either.
{
  const hiddenFirst: Column<Row>[] = [
    { header: "Hidden", get: (r) => r.name, shown: () => false },
    ...columns,
  ];
  assert.deepEqual(tableSort("t6", hiddenFirst), { header: "ID", descending: false });
  toggleSort("t6", hiddenFirst, "Hidden");
  assert.deepEqual(tableSort("t6", hiddenFirst), { header: "ID", descending: false });
}

// Sorting returns a new array and leaves the rows as given.
const before = [...rows];
sortedRows("t1", columns, rows);
assert.deepEqual(rows, before);

console.log("table sort checks: all assertions passed");
