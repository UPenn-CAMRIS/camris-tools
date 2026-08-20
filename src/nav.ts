export type ToolKey = "audit" | "contrast";

const TOOL_LABELS: Record<ToolKey, string> = {
  audit: "Audit Tool",
  contrast: "Contrast Injection Tool",
};

/** A small nav bar shown at the top of each tool page: a link home, and
 * a link to the other tool. Keeps navigation consistent across tools. */
export function renderPageNav(current: ToolKey): string {
  const other: ToolKey = current === "audit" ? "contrast" : "audit";
  return `
    <nav class="page-nav">
      <a href="#/">Home</a>
      <span aria-hidden="true">·</span>
      <a href="#/${other}">${TOOL_LABELS[other]}</a>
    </nav>
  `;
}
