export function renderLandingPage(app: HTMLElement): void {
  app.innerHTML = `
    <h1>CAMRIS Billing Tools</h1>
    <p class="subtitle">Choose a tool.</p>

    <div class="tool-grid">
      <a class="tool-card" href="#/audit">
        <h2>Audit Tool</h2>
        <p>Check Dogfish, CAMS, and REDCap exports against the billing audit rules.</p>
      </a>
      <a class="tool-card" href="#/contrast">
        <h2>Contrast Injection Tool</h2>
        <p>Build a contrast-injection billing file from the Contrast Report and technologist list.</p>
      </a>
    </div>
  `;
}
