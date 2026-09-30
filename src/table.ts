import { csvField, shownColumns, type Column } from "./csvExport";

/** How one table is sorted: by the column with `header`, A to Z, or Z to A
 * when `descending`. */
export interface TableSort {
  header: string;
  descending: boolean;
}

// Each table's sort, by container ID. It lasts while the page is open, so
// re-running the audit keeps the sort a user chose.
const sorts = new Map<string, TableSort>();

/** True when a table can be sorted by `col`: it is shown, and not
 * screen-only (such as a remove button, which has no values). */
function canSortBy<T>(col: Column<T>): boolean {
  return !col.screenOnly && (col.shown?.() ?? true);
}

/** The column a table can be sorted by for `header`, or undefined when
 * there is no such column. */
function sortableColumn<T>(
  columns: Column<T>[],
  header: string
): Column<T> | undefined {
  return columns.find((col) => col.header === header && canSortBy(col));
}

/** The table's sort: the one chosen for it, else the first column A to Z. */
export function tableSort<T>(
  containerId: string,
  columns: Column<T>[]
): TableSort | undefined {
  const chosen = sorts.get(containerId);
  if (chosen && sortableColumn(columns, chosen.header)) return chosen;
  const first = columns.find(canSortBy);
  return first && { header: first.header, descending: false };
}

/** Sorts by `header`: A to Z the first time, then Z to A, and back. */
export function toggleSort<T>(
  containerId: string,
  columns: Column<T>[],
  header: string
): void {
  const current = tableSort(containerId, columns);
  sorts.set(containerId, {
    header,
    descending: current?.header === header ? !current.descending : false,
  });
}

/** `rows` in the order the table shows them: sorted by the text of the
 * sort column, as the CSV export writes it, compared as text (so "10"
 * comes before "9"). Rows with the same text keep their order from
 * `rows`, in both directions. The CSV export uses this order too, so the
 * file matches the screen. */
export function sortedRows<T>(
  containerId: string,
  columns: Column<T>[],
  rows: T[]
): T[] {
  const sort = tableSort(containerId, columns);
  const col = sort && sortableColumn(columns, sort.header);
  if (!sort || !col) return rows;
  const sign = sort.descending ? -1 : 1;
  const text = rows.map((row) => csvField(col.get(row)));
  return rows
    .map((row, i) => ({ row, text: text[i] }))
    .sort((a, b) => sign * a.text.localeCompare(b.text))
    .map(({ row }) => row);
}

export function renderTable<T>(
  containerId: string,
  allColumns: Column<T>[],
  unsortedRows: T[],
  emptyMessage: string
): void {
  const columns = shownColumns(allColumns);
  const container = document.getElementById(containerId)!;
  container.innerHTML = "";

  if (unsortedRows.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = emptyMessage;
    container.appendChild(note);
    return;
  }

  const rows = sortedRows(containerId, columns, unsortedRows);
  const sort = tableSort(containerId, columns);

  // This says whether each column holds boolean values. It checks the
  // first row once, then reuses the result for every header and body
  // cell in that column.
  const isBoolColumn = columns.map(
    (col) => typeof col.get(rows[0]) === "boolean"
  );

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach((col, i) => {
    const th = document.createElement("th");
    if (isBoolColumn[i]) th.className = "bool-cell";
    if (col.screenOnly) {
      th.textContent = col.header;
    } else {
      // Clicking a header sorts by it, A to Z, then Z to A.
      const sorted = sort?.header === col.header;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sort-header";
      button.dataset.header = col.header;
      button.textContent = col.header;
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = sorted ? (sort!.descending ? "▼" : "▲") : "";
      button.appendChild(arrow);
      button.addEventListener("click", () => {
        toggleSort(containerId, columns, col.header);
        renderTable(containerId, allColumns, unsortedRows, emptyMessage);
        // Keep keyboard focus on the header that was used.
        for (const header of container.querySelectorAll<HTMLButtonElement>(
          ".sort-header"
        )) {
          if (header.dataset.header === col.header) header.focus();
        }
      });
      th.appendChild(button);
      th.setAttribute(
        "aria-sort",
        sorted ? (sort!.descending ? "descending" : "ascending") : "none"
      );
    }
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    columns.forEach((col, i) => {
      const td = document.createElement("td");
      const value = col.get(row);
      const classes: string[] = [];
      if (col.render) {
        td.appendChild(col.render(row));
      } else if (isBoolColumn[i]) {
        td.textContent = value ? "✓" : "";
        classes.push("bool-cell");
        if (value) classes.push("bool-true");
      } else {
        td.textContent = value as string;
      }
      if (col.wrap) classes.push("wrap-cell");
      if (classes.length > 0) td.className = classes.join(" ");
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  container.appendChild(table);
}
