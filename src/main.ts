import "./style.css";
import { confirmLeave, setLeaveGuard } from "./leaveGuard";

const app = document.getElementById("app")!;

function currentHash(): string {
  return window.location.hash || "#/";
}

let renderedRoute = currentHash();

// Each page is loaded on demand, so visiting the audit tool never pulls
// in the Excel-parsing library the contrast tool needs, and vice versa.
async function render(): Promise<void> {
  const route = currentHash();
  renderedRoute = route;
  setLeaveGuard(null);
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

// A page with unsaved work can refuse a route change. The address has
// already changed by the time this event fires, so it is put back.
window.addEventListener("hashchange", () => {
  if (currentHash() === renderedRoute) return;
  if (!confirmLeave()) {
    history.replaceState(null, "", renderedRoute);
    return;
  }
  render();
});
render();
