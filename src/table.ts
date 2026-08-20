import type { Column } from "./csvExport";

export function renderTable<T>(
  containerId: string,
  columns: Column<T>[],
  rows: T[],
  emptyMessage: string
): void {
  const container = document.getElementById(containerId)!;
  container.innerHTML = "";

  if (rows.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = emptyMessage;
    container.appendChild(note);
    return;
  }

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
    th.textContent = col.header;
    if (isBoolColumn[i]) th.className = "bool-cell";
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
      if (isBoolColumn[i]) {
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
