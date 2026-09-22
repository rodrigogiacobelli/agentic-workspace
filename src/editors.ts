// The registry of CodeMirror views, keyed by editor tab id, and the set of
// tabs with unsaved changes. Both live outside React.

import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { api } from "./api";

export interface EditorInstance {
  view: EditorView;
  el: HTMLDivElement;
  workspaceId: string;
  path: string;
  saved: string;
}

const registry = new Map<string, EditorInstance>();
const dirty = new Set<string>();
const dirtyListeners = new Set<() => void>();

export function onDirty(cb: () => void): () => void {
  dirtyListeners.add(cb);
  return () => dirtyListeners.delete(cb);
}

export function isDirty(id: string): boolean {
  return dirty.has(id);
}

export function dirtyCount(): number {
  return dirty.size;
}

function setDirty(id: string, value: boolean): void {
  const had = dirty.has(id);
  if (value) dirty.add(id);
  else dirty.delete(id);
  if (had !== value) dirtyListeners.forEach((cb) => cb());
}

const darkTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)" },
    ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.5" },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-dim)", borderRight: "1px solid var(--border)" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.03)" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection)" },
    ".cm-selectionBackground": { backgroundColor: "var(--selection)" },
  },
  { dark: true },
);

export async function mount(id: string, workspaceId: string, path: string, container: HTMLElement): Promise<EditorInstance> {
  let inst = registry.get(id);
  if (!inst) {
    const text = await api.readFile(workspaceId, path);
    const el = document.createElement("div");
    el.className = "editor";
    const created: EditorInstance = { view: null as unknown as EditorView, el, workspaceId, path, saved: text };
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          darkTheme,
          keymap.of([{ key: "Mod-s", run: () => { void save(id); return true; } }]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(id, u.state.doc.toString() !== created.saved);
          }),
        ],
      }),
    });
    created.view = view;
    inst = created;
    registry.set(id, inst);
  }
  if (inst.el.parentElement !== container) container.replaceChildren(inst.el);
  inst.view.focus();
  return inst;
}

export function unmount(id: string): void {
  registry.get(id)?.el.remove();
}

export function dispose(id: string): void {
  const inst = registry.get(id);
  if (!inst) return;
  registry.delete(id);
  inst.view.destroy();
  inst.el.remove();
  setDirty(id, false);
}

export function retain(ids: Set<string>): void {
  for (const id of [...registry.keys()]) if (!ids.has(id)) dispose(id);
}

export async function save(id: string): Promise<void> {
  const inst = registry.get(id);
  if (!inst) return;
  const content = inst.view.state.doc.toString();
  await api.writeFile(inst.workspaceId, inst.path, content);
  inst.saved = content;
  setDirty(id, false);
}
