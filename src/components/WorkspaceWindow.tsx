import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, events } from "../api";
import * as editors from "../editors";
import { actionFor } from "../hotkeys";
import type { DiffTarget, RepoInfo, Session, StatusEntry, Workspace } from "../types";
import { EditorArea, closeTab } from "./EditorArea";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";
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
  const [sidebar, setSidebar] = useState<"files" | "search" | "git">("files");
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [gitStatus, setGitStatus] = useState<StatusEntry[]>([]);
  const [gitInfo, setGitInfo] = useState<RepoInfo | null>(null);
  const [gitTick, setGitTick] = useState(0);
  const [, bump] = useState(0);

  // Git status follows the working tree: any change in the workspace, or in
  // its repository, refreshes it.
  const refreshGit = useCallback(() => setGitTick((n) => n + 1), []);
  useEffect(() => {
    if (!ws) return;
    let cancelled = false;
    api.gitInfo(ws.id).then((i) => { if (!cancelled) setGitInfo(i); }).catch(() => setGitInfo({ isRepo: false, branch: null, detached: false, state: null, isWorktree: false, mainWorktree: null, upstream: null, ahead: 0, behind: 0 }));
    api.gitStatus(ws.id).then((s) => { if (!cancelled) setGitStatus(s); }).catch(() => setGitStatus([]));
    return () => { cancelled = true; };
  }, [ws?.id, gitTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let timer: number | null = null;
    const schedule = (id: string) => {
      if (id !== ws?.id) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(refreshGit, 300);
    };
    const a = events.onDirChanged((c) => schedule(c.workspaceId));
    const b = events.onGitChanged(schedule);
    return () => { void a.then((u) => u()); void b.then((u) => u()); if (timer) window.clearTimeout(timer); };
  }, [ws?.id, refreshGit]);
  useEffect(() => { setDiff(null); }, [ws?.id]);

  useEffect(() => editors.subscribe(() => bump((n) => n + 1)), []);
  useEffect(() => {
    editors.retain(new Set(session.workspaces.flatMap((w) => w.editors.map((e) => e.id))));
  }, [session]);

  // Links inside documents open files here; notices surface here.
  useEffect(() => {
    editors.setHooks({
      openFile: (rel) => { if (ws) void api.openFile(ws.id, rel).catch(report); },
      notice: (m) => report(m),
      showCommit: (hash) => { setSidebar("git"); window.dispatchEvent(new CustomEvent("show-commit", { detail: hash })); },
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
        case "git": setSidebar("git"); break;
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
          <button className={sidebar === "git" ? "active" : ""} onClick={() => setSidebar("git")} title="Ctrl+Shift+G">Git{gitStatus.length ? ` ${gitStatus.length}` : ""}</button>
        </div>
        {!ws.available ? (
          <div className="tree-loading">The directory {ws.path} is missing.</div>
        ) : sidebar === "files" ? (
          <FileTree key={ws.id} ws={ws} selected={selected} onSelect={setSelected} onOpen={(p) => void api.openFile(ws.id, p).catch(report)} gitStatus={gitStatus} />
        ) : sidebar === "search" ? (
          <SearchPanel key={ws.id} ws={ws} onOpen={openAt} />
        ) : (
          <GitPanel key={ws.id} ws={ws} session={session} status={gitStatus} info={gitInfo} refresh={refreshGit} onDiff={setDiff} onOpenFile={(p) => void api.openFile(ws.id, p).catch(report)} />
        )}
      </aside>
      <EditorArea ws={ws} diff={diff} onCloseDiff={() => setDiff(null)} onDiffChanged={refreshGit} />
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
