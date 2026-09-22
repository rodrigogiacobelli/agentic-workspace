/** A message for the user that has no other way out: it shows as a toast in this window. */
export function report(e: unknown): void {
  console.error(e);
  window.dispatchEvent(new CustomEvent("app-notice", { detail: String(e) }));
}
