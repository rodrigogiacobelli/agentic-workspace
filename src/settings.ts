// The settings client: one snapshot, applied to the chrome, the terminals and
// the editors whenever the backend publishes a change.

import { api, events } from "./api";
import { setImported, themeById, type Theme } from "./themes";
import type { ImportedTheme, Settings } from "./types";

let current: Settings | null = null;
let activePath: string | null = null;
const listeners = new Set<(s: Settings) => void>();

function asTheme(t: ImportedTheme): Theme {
  return { id: t.id, name: `${t.name} (imported)`, dark: t.dark, ui: t.ui as Theme["ui"], terminal: t.terminal as Theme["terminal"], syntax: t.syntax as Theme["syntax"] };
}

export async function reloadImported(): Promise<void> {
  setImported((await api.listThemes()).map(asTheme));
  if (current) apply(current);
}

/** The active workspace's path, so its theme override can apply. */
export function setActivePath(path: string | null): void {
  if (path === activePath) return;
  activePath = path;
  if (current) apply(current);
}

export function activeThemeId(): string {
  const override = activePath ? current?.workspaces[activePath]?.theme : null;
  return override || current?.theme || "graphite";
}

export const monospaceFallback =
  '"JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "Cascadia Code", "DejaVu Sans Mono", monospace';
export const proseFallback = '"Inter", "Noto Sans", system-ui, sans-serif';

export function get(): Settings | null {
  return current;
}

export function theme(): Theme {
  return themeById(activeThemeId());
}

export function subscribe(cb: (s: Settings) => void): () => void {
  listeners.add(cb);
  if (current) cb(current);
  return () => listeners.delete(cb);
}

export async function init(): Promise<Settings> {
  const s = await api.getSettings();
  current = s;
  await reloadImported().catch(() => {});
  apply(s);
  void events.onSettings(apply);
  return s;
}

export async function update(patch: Partial<Settings>): Promise<void> {
  if (!current) return;
  const next = await api.updateSettings({ ...current, ...patch });
  apply(next);
}

function apply(s: Settings): void {
  current = s;
  const t = themeById(activeThemeId());
  const root = document.documentElement.style;
  root.setProperty("--bg", t.ui.bg);
  root.setProperty("--bg-raised", t.ui.bgRaised);
  root.setProperty("--bg-hover", t.ui.bgHover);
  root.setProperty("--fg", t.ui.fg);
  root.setProperty("--fg-dim", t.ui.fgDim);
  root.setProperty("--fg-faint", t.ui.fgFaint);
  root.setProperty("--border", t.ui.border);
  root.setProperty("--accent", t.ui.accent);
  root.setProperty("--selection", t.ui.selection);
  root.setProperty("--danger", t.ui.danger);
  root.setProperty("--code-bg", t.ui.codeBg);
  for (const [k, v] of Object.entries(t.syntax)) root.setProperty(`--syn-${k}`, v);
  root.setProperty("--mono", s.editorFontFamily ? `"${s.editorFontFamily}", ${monospaceFallback}` : monospaceFallback);
  root.setProperty("--prose", s.proseFontFamily ? `"${s.proseFontFamily}", ${proseFallback}` : proseFallback);
  root.setProperty("--editor-size", `${s.editorFontSize}px`);
  root.setProperty("--prose-size", `${s.proseFontSize}px`);
  document.documentElement.dataset.theme = t.dark ? "dark" : "light";
  document.documentElement.style.colorScheme = t.dark ? "dark" : "light";
  listeners.forEach((cb) => cb(s));
}

export function terminalFont(s: Settings): { fontFamily: string; fontSize: number; lineHeight: number } {
  return {
    fontFamily: s.terminalFontFamily ? `"${s.terminalFontFamily}", ${monospaceFallback}` : monospaceFallback,
    fontSize: s.terminalFontSize,
    lineHeight: s.terminalLineHeight,
  };
}
