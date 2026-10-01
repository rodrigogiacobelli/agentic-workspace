// The registry of open documents, keyed by editor tab id, and the set of tabs
// with unsaved changes. Both live outside React.

import { api } from "./api";
import { Doc, type DocHooks, type Mode } from "./editor/document";
import { languageFor } from "./editor/languages";
import { mediaKind } from "./editor/preview";
import { modalOpen } from "./modal";
import * as settings from "./settings";
import type { EditorGroup, EditorTab, Workspace } from "./types";

export function activeGroup(ws: Workspace): EditorGroup | undefined {
  return ws.groups.find((g) => g.id === ws.activeGroup) ?? ws.groups[0];
}

export function activeEditorId(ws: Workspace): string | null {
  return activeGroup(ws)?.activeEditor ?? null;
}

/** Every tab open anywhere: the Editor's files and Source Control's diffs. */
export function allTabIds(workspaces: Workspace[]): Set<string> {
  return new Set(workspaces.flatMap((w) => [...w.groups, ...w.review.groups].flatMap((g) => g.editors.map((e) => e.id))));
}

/**
 * A file shown as itself. `stamp` names the version of the file on disk,
 * which a viewer draws, and is null while no file is there (IMG-09, IMG-09a).
 */
export interface Media {
  media: "image" | "audio" | "video";
  workspaceId: string;
  path: string;
  stamp: string | null;
}

/** An open tab: a text document, media shown as itself, or a file the editor declines. */
export type Entry = { doc: Doc } | { binary: string } | Media;

const registry = new Map<string, Entry>();
const listeners = new Set<() => void>();
const pending = new Map<string, { line: number; column: number }>();
/** Media tabs a mount gave the keyboard, for their viewers to take once drawn. */
const owedFocus = new Set<string>();
let hooks: DocHooks = { openFile: () => {}, openIn: () => {}, reveal: () => {}, workspaces: () => [], notice: () => {}, showCommit: () => {} };

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

function media(id: string): Media | undefined {
  const e = registry.get(id);
  return e && "media" in e ? e : undefined;
}

/** Whether a tab's file was deleted or moved on disk: its label is struck through (ED-22, IMG-09a). */
export function detached(id: string): boolean {
  const e = registry.get(id);
  return !!e && ("doc" in e ? e.doc.detached : "media" in e && e.stamp === null);
}

/** Gives the keyboard to a tab's document, or to its viewer when that is drawn. */
export function focus(id: string): void {
  const d = doc(id);
  if (d) d.focus();
  else document.querySelector<HTMLElement>(`[data-viewer="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

/** Whether the last mount of a media tab gave it the keyboard; asked once, by its viewer. */
export function takeFocus(id: string): boolean {
  return owedFocus.delete(id);
}

export function isDirty(id: string): boolean {
  return doc(id)?.dirty ?? false;
}

export function dirtyCount(): number {
  let n = 0;
  for (const e of registry.values()) if ("doc" in e && e.doc.dirty) n++;
  return n;
}

/** Shows a tab's document in `container`, opening it first if needed; `focus` false leaves focus where it is. */
export async function mount(ws: Workspace, tab: EditorTab, container: HTMLElement, focus = true): Promise<Entry> {
  let entry = registry.get(tab.id);
  const kind = mediaKind(tab.path);
  if (!entry && kind !== "file") {
    // Asked first, so the first picture drawn is already of this version. A
    // stat that fails leaves it to the picture to load or not.
    const stamp = await api.fileStamp(ws.id, tab.path).catch(() => "");
    entry = { media: kind, workspaceId: ws.id, path: tab.path, stamp };
    registry.set(tab.id, entry);
    notify();
  }
  if (entry && "media" in entry) {
    // As a document takes it (Doc.mount), once its viewer is drawn.
    if (focus && !modalOpen() && !document.activeElement?.closest(".tree")) owedFocus.add(tab.id);
    else owedFocus.delete(tab.id);
    return entry;
  }
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
    // The first edit makes a preview tab permanent (ED-31).
    if (tab.preview) {
      const stop = d.subscribe(() => {
        if (!d.dirty) return;
        stop();
        void api.pinEditor(ws.id, tab.id).catch(() => {});
      });
    }
    const draft = await api.readDraft(ws.id, tab.path).catch(() => null);
    if (draft !== null && draft !== text) d.restoreDraft(draft);
    else if (draft !== null) void api.deleteDraft(ws.id, tab.path).catch(() => {});
    // Registered only once it is shown just below: a group mounts again when
    // the registry gains its tab, and that mount must find the document
    // already in place rather than show it first, taking focus it was not given.
    entry = { doc: d };
    registry.set(tab.id, entry);
    notify();
  }
  if ("doc" in entry) {
    // Behind a modal the keyboard stays with the modal.
    entry.doc.mount(container, tab.line || 1, focus && !modalOpen());
    const target = pending.get(tab.id);
    if (target) {
      pending.delete(tab.id);
      entry.doc.jumpToLine(target.line, target.column);
    }
  }
  return entry;
}

/** Takes a document off `container`; one already shown in another group stays there. */
export function unmount(id: string, container: HTMLElement): void {
  doc(id)?.unmount(container);
}

export function dispose(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  registry.delete(id);
  owedFocus.delete(id);
  if ("doc" in entry) entry.doc.dispose();
  notify();
}

export function retain(ids: Set<string>): void {
  for (const id of [...registry.keys()]) if (!ids.has(id)) dispose(id);
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function extensionOf(path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  return name.includes(".") ? name.slice(name.lastIndexOf(".")) : name;
}

/**
 * A tab is the same tab after its file is renamed or moved: the backend
 * rewrote the path it carries, and the open document follows it here. This
 * reaches tabs that are not on screen, which is where the file would
 * otherwise go on showing as deleted until the tab was closed and reopened.
 */
export function follow(workspaces: Workspace[]): void {
  for (const ws of workspaces) {
    for (const group of ws.groups) {
      for (const tab of group.editors) {
        const entry = registry.get(tab.id);
        if (entry && "media" in entry && entry.path !== tab.path) {
          // Shown as what its new name says it is.
          if (mediaKind(tab.path) !== entry.media) dispose(tab.id);
          else {
            registry.set(tab.id, { ...entry, path: tab.path });
            void checkMedia(tab.id);
          }
          continue;
        }
        if (!entry || !("doc" in entry) || entry.doc.path === tab.path) continue;
        // The extension decides the language, the mode and the comment token
        // Ctrl+/ inserts, and all three are fixed when the document is built.
        // A clean buffer is cheaper to rebuild than to patch; a dirty one
        // keeps what it has rather than lose the changes in it.
        if (!entry.doc.dirty && extensionOf(tab.path) !== extensionOf(entry.doc.path)) dispose(tab.id);
        else entry.doc.relocate(tab.path);
      }
    }
  }
}

/** The session changed: each document whose worktree family moved draws its paths again (ADR-015). */
export function refreshFamilies(): void {
  for (const entry of registry.values()) if ("doc" in entry) entry.doc.refreshFamily();
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

/**
 * A directory changed on disk: every open document inside it re-reads its
 * file, every media tab there asks whether its file changed or went, and
 * every document of the workspace looks its citations up again.
 */
export function checkDisk(workspaceId: string, dirs: string[]): void {
  const inTree = dirs.some((d) => d !== ".git" && !d.startsWith(".git/"));
  for (const [id, entry] of registry) {
    if ("media" in entry) {
      if (entry.workspaceId === workspaceId && dirs.includes(dirOf(entry.path))) void checkMedia(id);
      continue;
    }
    if (!("doc" in entry) || entry.doc.workspaceId !== workspaceId) continue;
    if (inTree) entry.doc.invalidateExistence();
    if (dirs.includes(dirOf(entry.doc.path))) void entry.doc.checkDisk();
  }
}

/**
 * A media tab's file as it is now. A new stamp is a rewritten, replaced or
 * recreated file, which its viewer draws again; none is a deleted one. An
 * unanswered question leaves the tab as it was.
 */
async function checkMedia(id: string): Promise<void> {
  const asked = media(id);
  if (!asked) return;
  const stamp = await api.fileStamp(asked.workspaceId, asked.path).catch(() => asked.stamp);
  const now = media(id);
  if (!now || now.path !== asked.path || now.stamp === stamp) return;
  registry.set(id, { ...now, stamp });
  notify();
}

/**
 * The workspace's git directory changed, the index with it perhaps: every
 * open document of it compares against the index again (GIT-14). This is
 * heard straight from the watcher, not through the repository store, whose
 * own wait would leave the marks of a staged file up past 300 ms.
 */
export function gitChanged(workspaceId: string): void {
  for (const entry of registry.values()) if ("doc" in entry && entry.doc.workspaceId === workspaceId) entry.doc.refreshBase();
}

/** Re-creates a document so a new language override takes effect. */
export function reopen(id: string): void {
  const entry = registry.get(id);
  if (!entry || !("doc" in entry) || entry.doc.dirty) return;
  dispose(id);
}
