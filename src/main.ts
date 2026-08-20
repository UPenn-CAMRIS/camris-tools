import "./style.css";

const app = document.getElementById("app")!;

// Each page is loaded on demand, so visiting the audit tool never pulls
// in the Excel-parsing library the contrast tool needs, and vice versa.
async function render(): Promise<void> {
  const route = window.location.hash || "#/";
  app.innerHTML = "";

  switch (route) {
    case "#/audit": {
      const { renderAuditPage } = await import("./pages/audit");
      renderAuditPage(app);
      break;
    }
    case "#/contrast": {
      const { renderContrastPage } = await import("./pages/contrast");
      renderContrastPage(app);
      break;
    }
    default: {
      const { renderLandingPage } = await import("./pages/landing");
      renderLandingPage(app);
    }
  }
}

window.addEventListener("hashchange", render);
render();
