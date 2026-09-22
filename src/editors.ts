// The registry of open documents, keyed by editor tab id, and the set of tabs
// with unsaved changes. Both live outside React.

import { api } from "./api";
import { Doc, type DocHooks, type Mode } from "./editor/document";
import { languageFor } from "./editor/languages";
import * as settings from "./settings";
import type { EditorTab, Workspace } from "./types";

export type Entry = { doc: Doc } | { binary: string };

const registry = new Map<string, Entry>();
const listeners = new Set<() => void>();
const pending = new Map<string, { line: number; column: number }>();
let hooks: DocHooks = { openFile: () => {}, notice: () => {}, showCommit: () => {} };

export function setHooks(h: DocHooks): void {
  hooks = h;
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(): void {
  listeners.forEach((cb) => cb());
}

export function get(id: string): Entry | undefined {
  return registry.get(id);
}

export function doc(id: string): Doc | undefined {
  const e = registry.get(id);
  return e && "doc" in e ? e.doc : undefined;
}

export function isDirty(id: string): boolean {
  return doc(id)?.dirty ?? false;
}

export function dirtyCount(): number {
  let n = 0;
  for (const e of registry.values()) if ("doc" in e && e.doc.dirty) n++;
  return n;
}

export async function mount(ws: Workspace, tab: EditorTab, container: HTMLElement): Promise<Entry> {
  let entry = registry.get(tab.id);
  if (!entry) {
    let text: string;
    try {
      text = await api.readFile(ws.id, tab.path);
    } catch (e) {
      const message = String(e);
      if (/not UTF-8/.test(message)) {
        entry = { binary: message };
        registry.set(tab.id, entry);
        notify();
        return entry;
      }
      throw e;
    }
    const override = settings.get()?.languages[`${ws.path}/${tab.path}`];
    const d = new Doc(tab.id, ws.id, ws.path, tab.path, text, languageFor(tab.path, override), tab.mode as Mode, hooks);
    d.subscribe(notify);
    entry = { doc: d };
    registry.set(tab.id, entry);
    notify();
  }
  if ("doc" in entry) {
    entry.doc.mount(container, tab.line || 1);
    const target = pending.get(tab.id);
    if (target) {
      pending.delete(tab.id);
      entry.doc.jumpToLine(target.line, target.column);
    }
  }
  return entry;
}

export function unmount(id: string): void {
  doc(id)?.unmount();
}

export function dispose(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  registry.delete(id);
  if ("doc" in entry) entry.doc.dispose();
  notify();
}

export function retain(ids: Set<string>): void {
  for (const id of [...registry.keys()]) if (!ids.has(id)) dispose(id);
}

export async function save(id: string): Promise<void> {
  await doc(id)?.save();
}

/** Jumps to a 1-based line, now if the document is open, else when it opens. */
export function revealLine(id: string, line: number, column = 0): void {
  const d = doc(id);
  if (d) d.jumpToLine(line, column);
  else pending.set(id, { line, column });
}

/** A directory changed on disk: every open document inside it re-reads its file. */
export function checkDisk(workspaceId: string, dirs: string[]): void {
  for (const entry of registry.values()) {
    if (!("doc" in entry) || entry.doc.workspaceId !== workspaceId) continue;
    const dir = entry.doc.path.includes("/") ? entry.doc.path.slice(0, entry.doc.path.lastIndexOf("/")) : "";
    if (dirs.includes(dir)) void entry.doc.checkDisk();
  }
}

/** Re-creates a document so a new language override takes effect. */
export function reopen(id: string): void {
  const entry = registry.get(id);
  if (!entry || !("doc" in entry) || entry.doc.dirty) return;
  dispose(id);
}
