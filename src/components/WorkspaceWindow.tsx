import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import * as editors from "../editors";
import { actionFor } from "../hotkeys";
import type { Session, Workspace } from "../types";
import { FileTree } from "./FileTree";
import { Palette, type PaletteItem } from "./Palette";
import { report } from "./Switcher";

interface Props {
  session: Session;
  openSwitcher: () => void;
}

export function WorkspaceWindow({ session, openSwitcher }: Props) {
  const ws = session.workspaces.find((w) => w.id === session.active);
  const [selected, setSelected] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState<PaletteItem[] | null>(null);
  const [, bump] = useState(0);

  useEffect(() => editors.onDirty(() => bump((n) => n + 1)), []);
  useEffect(() => {
    editors.retain(new Set(session.workspaces.flatMap((w) => w.editors.map((e) => e.id))));
  }, [session]);

  const openQuickOpen = async () => {
    if (!ws) return;
    const files = await api.listFiles(ws.id).catch((e) => { report(e); return [] as string[]; });
    const recent = ws.recentFiles.filter((p) => files.includes(p));
    const rest = files.filter((p) => !recent.includes(p));
    setQuickOpen([...recent, ...rest].map((p) => ({ id: p, label: p })));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = actionFor(e);
      if (!action) return;
      switch (action) {
        case "switch-workspace": openSwitcher(); break;
        case "focus-other-window": void api.focusWindow("terminal"); break;
        case "quick-open": void openQuickOpen(); break;
        case "save": if (ws?.activeEditor) void editors.save(ws.activeEditor).catch(report); break;
        case "close-editor": if (ws?.activeEditor) void closeTab(ws, ws.activeEditor); break;
        case "next-tab": cycle(ws, 1); break;
        case "prev-tab": cycle(ws, -1); break;
        case "copy-relative-path": {
          const path = selected ?? ws?.editors.find((t) => t.id === ws.activeEditor)?.path;
          if (path) void api.copyText(path);
          break;
        }
        case "quit": void api.requestQuit(); break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!ws) {
    return <main className="empty">Add a folder to start.</main>;
  }

  return (
    <main className="workspace-main">
      {ws.available ? (
        <FileTree key={ws.id} ws={ws} selected={selected} onSelect={setSelected} onOpen={(p) => void api.openFile(ws.id, p).catch(report)} />
      ) : (
        <nav className="tree"><div className="tree-loading">The directory {ws.path} is missing.</div></nav>
      )}
      <EditorArea ws={ws} />
      {quickOpen && (
        <Palette
          title="Open file"
          items={quickOpen}
          onClose={() => setQuickOpen(null)}
          onPick={(item) => { setQuickOpen(null); void api.openFile(ws.id, item.id).catch(report); }}
        />
      )}
    </main>
  );
}

function cycle(ws: Workspace | undefined, delta: number) {
  if (!ws || ws.editors.length === 0) return;
  const i = ws.editors.findIndex((t) => t.id === ws.activeEditor);
  const next = ws.editors[(i + delta + ws.editors.length) % ws.editors.length];
  void api.setActiveEditor(ws.id, next.id);
}

async function closeTab(ws: Workspace, id: string) {
  if (editors.isDirty(id)) {
    const path = ws.editors.find((t) => t.id === id)?.path ?? "this file";
    const discard = await ask(`${path} has unsaved changes. Close it and discard them?`, {
      title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep open",
    });
    if (!discard) return;
  }
  await api.closeFile(ws.id, id);
}

function EditorArea({ ws }: { ws: Workspace }) {
  const host = useRef<HTMLDivElement>(null);
  const shownRef = useRef<string | null>(null);
  const dragging = useRef<string | null>(null);
  const activeId = ws.activeEditor;

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    if (shownRef.current && shownRef.current !== activeId) editors.unmount(shownRef.current);
    shownRef.current = activeId;
    const tab = ws.editors.find((t) => t.id === activeId);
    if (tab) void editors.mount(tab.id, ws.id, tab.path, container).catch(report);
  }, [activeId, ws.id, ws.editors]);

  const drop = (targetId: string) => {
    const from = dragging.current;
    dragging.current = null;
    if (!from || from === targetId) return;
    const ids = ws.editors.map((t) => t.id);
    ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(targetId), 0, from);
    void api.reorderEditors(ws.id, ids);
  };

  return (
    <section className="editor-area">
      <div className="tabs">
        {ws.editors.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === activeId ? " active" : ""}`}
            draggable
            onDragStart={() => { dragging.current = tab.id; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(tab.id)}
            onClick={() => void api.setActiveEditor(ws.id, tab.id)}
            title={tab.path}
          >
            <span className="tab-label">{editors.isDirty(tab.id) ? "● " : ""}{tab.path.split("/").pop()}</span>
            <button className="tab-close" onClick={(e) => { e.stopPropagation(); void closeTab(ws, tab.id); }} title="Close (Ctrl+W)">×</button>
          </div>
        ))}
      </div>
      <div className="editor-host" ref={host}>
        {ws.editors.length === 0 && <div className="empty">Open a file from the tree, or press Ctrl+P.</div>}
      </div>
    </section>
  );
}
