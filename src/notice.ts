/**
 * How long a toast stays once its window is looked at, whatever it says
 * (NTF-01). A number rather than a motion token: reduced motion shortens the
 * tokens, and must not shorten the time to read.
 */
export const NOTICE_DWELL_MS = 2000;

/** A failure with no other way out: a toast in this window, in the danger colour. */
export function report(e: unknown): void {
  console.error(e);
  window.dispatchEvent(new CustomEvent("app-notice", { detail: String(e) }));
}

/** A short confirmation of something that worked: the same toast in the neutral colour. */
export function notify(text: string): void {
  window.dispatchEvent(new CustomEvent("app-notice", { detail: { text, kind: "info" } }));
}
