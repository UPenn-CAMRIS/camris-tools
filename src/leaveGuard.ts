/** Returns a message when the current page has unsaved work, else null. */
type UnsavedCheck = () => string | null;

let check: UnsavedCheck | null = null;

/** Sets the current page's unsaved-work check. The router clears it
 * before rendering each page. */
export function setLeaveGuard(unsaved: UnsavedCheck | null): void {
  check = unsaved;
}

/** True when the current page can be left: it has no unsaved work, or
 * the user confirms leaving anyway. */
export function confirmLeave(): boolean {
  const message = check?.();
  return !message || window.confirm(message);
}

// Closing or reloading the tab. Browsers show their own wording here,
// not the page's message.
window.addEventListener("beforeunload", (event) => {
  if (check?.()) event.preventDefault();
});
