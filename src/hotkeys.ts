// One place naming every key binding, so the two windows and the terminal's
// key interception agree on what the application claims.

export type Action =
  | "switch-workspace"
  | "focus-other-window"
  | "quick-open"
  | "new-terminal"
  | "close-terminal"
  | "next-tab"
  | "prev-tab"
  | "copy"
  | "paste"
  | "search"
  | "save"
  | "close-editor"
  | "copy-relative-path"
  | "quit";

export function actionFor(e: KeyboardEvent): Action | null {
  const ctrl = e.ctrlKey;
  const shift = e.shiftKey;
  const alt = e.altKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!ctrl) return null;
  if (alt && shift && key === "c") return "copy-relative-path";
  if (alt) return null;
  if (shift) {
    switch (key) {
      case "p": return "switch-workspace";
      case " ": return "focus-other-window";
      case "t": return "new-terminal";
      case "w": return "close-terminal";
      case "c": return "copy";
      case "v": return "paste";
      case "f": return "search";
      case "Tab": return "prev-tab";
    }
    return null;
  }
  switch (key) {
    case "p": return "quick-open";
    case "Tab": return "next-tab";
    case "s": return "save";
    case "w": return "close-editor";
    case "q": return "quit";
  }
  return null;
}

/** Actions the terminal window claims before the shell sees the key. */
export const TERMINAL_ACTIONS = new Set<Action>([
  "switch-workspace", "focus-other-window", "new-terminal", "close-terminal",
  "next-tab", "prev-tab", "copy", "paste", "search", "quit",
]);
