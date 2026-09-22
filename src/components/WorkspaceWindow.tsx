import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, events } from "../api";
import * as editors from "../editors";
import { actionFor } from "../hotkeys";
import type { Session, Workspace } from "../types";
import { EditorArea, closeTab } from "./EditorArea";
import { FileTree } from "./FileTree";
import { Palette, type PaletteItem } from "./Palette";
import { SearchPanel } from "./SearchPanel";
import { report } from "./Switcher";

interface Props {
  session: Session;
  openSwitcher: () => void;
  openSettings: () => void;
}

export function WorkspaceWindow({ session, openSwitcher, openSettings }: Props) {
  const ws = session.workspaces.find((w) => w.id === session.active);
  const [selected, setSelected] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState<PaletteItem[] | null>(null);
  const [sidebar, setSidebar] = useState<"files" | "search">("files");
  const [, bump] = useState(0);

  useEffect(() => editors.subscribe(() => bump((n) => n + 1)), []);
  useEffect(() => {
    editors.retain(new Set(session.workspaces.flatMap((w) => w.editors.map((e) => e.id))));
  }, [session]);

  // Links inside documents open files here; notices surface here.
  useEffect(() => {
    editors.setHooks({
      openFile: (rel) => { if (ws) void api.openFile(ws.id, rel).catch(report); },
      notice: (m) => report(m),
    });
  }, [ws]);

  // An agent rewrote something: every open document in that directory checks its file.
  useEffect(() => {
    const unlisten = events.onDirChanged((change) => editors.checkDisk(change.workspaceId, change.dirs));
    return () => { void unlisten.then((u) => u()); };
  }, []);

  // Files dropped from the file manager land in the document under the pointer.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop" || !ws?.activeEditor) return;
      const doc = editors.doc(ws.activeEditor);
      if (!doc) return;
      const scale = window.devicePixelRatio || 1;
      const { x, y } = event.payload.position;
      void doc.insertPaths(event.payload.paths, { x: x / scale, y: y / scale });
    });
    return () => { void unlisten.then((u) => u()); };
  }, [ws?.activeEditor]);

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
        case "search": setSidebar("search"); break;
        case "settings": openSettings(); break;
        case "save": if (ws?.activeEditor) void editors.save(ws.activeEditor).catch(report); break;
        case "close-editor": if (ws?.activeEditor) void closeTab(ws, ws.activeEditor); break;
        case "cycle-mode": if (ws?.activeEditor) editors.doc(ws.activeEditor)?.cycleMode(); break;
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

  const openAt = (path: string, line: number, column: number) => {
    api.openFile(ws.id, path).then((id) => editors.revealLine(id, line, column)).catch(report);
  };

  return (
    <main className="workspace-main">
      <aside className="sidebar">
        <div className="sidebar-tabs">
          <button className={sidebar === "files" ? "active" : ""} onClick={() => setSidebar("files")}>Files</button>
          <button className={sidebar === "search" ? "active" : ""} onClick={() => setSidebar("search")} title="Ctrl+Shift+F">Search</button>
        </div>
        {!ws.available ? (
          <div className="tree-loading">The directory {ws.path} is missing.</div>
        ) : sidebar === "files" ? (
          <FileTree key={ws.id} ws={ws} selected={selected} onSelect={setSelected} onOpen={(p) => void api.openFile(ws.id, p).catch(report)} />
        ) : (
          <SearchPanel key={ws.id} ws={ws} onOpen={openAt} />
        )}
      </aside>
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
