import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, events } from "../api";
import * as editors from "../editors";
import { actionFor } from "../hotkeys";
import * as settings from "../settings";
import type { PanelId, PanelLayout, Region, RepoInfo, Session, StatusEntry, Workspace } from "../types";
import { PANELS, defaultLayout, dropPanel, hidePanel, leafKey, normalize, placePanel, resizeSplit, setActivePanel, showPanel, type DockLeaf } from "./dock";
import { EditorArea, closeTab, groupOrder } from "./EditorArea";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";
import { Outline } from "./Outline";
import { Palette, type PaletteItem } from "./Palette";
import { SearchPanel } from "./SearchPanel";
import { PANEL_MIME, SplitTree, useDropZone } from "./SplitTree";
import { report } from "./Switcher";

interface Props {
  session: Session;
  openSwitcher: () => void;
  openSettings: () => void;
}

const same = (a: PanelLayout, b: PanelLayout) => JSON.stringify(a) === JSON.stringify(b);

export function WorkspaceWindow({ session, openSwitcher, openSettings }: Props) {
  const ws = session.workspaces.find((w) => w.id === session.active);
  const [selected, setSelected] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState<PaletteItem[] | null>(null);
  const [gitStatus, setGitStatus] = useState<StatusEntry[]>([]);
  const [gitInfo, setGitInfo] = useState<RepoInfo | null>(null);
  const [gitTick, setGitTick] = useState(0);
  const [, bump] = useState(0);

  // The panel layout is the application's, kept with the settings; the
  // settings dialog can reset it or show a hidden panel from any window.
  const [layout, setLayout] = useState<PanelLayout>(() => normalize(settings.get()?.panelLayout ?? defaultLayout()));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => settings.subscribe((s) => {
    const next = normalize(s.panelLayout ?? defaultLayout());
    if (!same(next, layoutRef.current)) setLayout(next);
  }), []);
  const update = useCallback((next: PanelLayout) => {
    if (same(next, layoutRef.current)) return;
    setLayout(next);
    void settings.update({ panelLayout: next }).catch(report);
  }, []);
  const focusPanel = useCallback((id: PanelId) => update(showPanel(layoutRef.current, id)), [update]);

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

  useEffect(() => editors.subscribe(() => bump((n) => n + 1)), []);
  useEffect(() => {
    editors.retain(editors.allTabIds(session.workspaces));
  }, [session]);

  // Links inside documents open files here; notices surface here.
  useEffect(() => {
    editors.setHooks({
      openFile: (rel) => { if (ws) void api.openFile(ws.id, rel, true).catch(report); },
      notice: (m) => report(m),
      showCommit: (hash) => { focusPanel("git"); window.dispatchEvent(new CustomEvent("show-commit", { detail: hash })); },
    });
  }, [ws, focusPanel]);

  // A terminal link or a notification asked for a file at a line.
  useEffect(() => {
    const unlisten = events.onOpenAt(async (t) => {
      if (t.workspaceId !== session.active) await api.switchWorkspace(t.workspaceId).catch(report);
      api.openFile(t.workspaceId, t.path, true).then((id) => { if (t.line > 0) editors.revealLine(id, t.line, Math.max(0, t.column - 1)); }).catch(report);
    });
    return () => { void unlisten.then((u) => u()); };
  }, [session.active]);

  // An agent rewrote something: every open document in that directory checks its file.
  useEffect(() => {
    const unlisten = events.onDirChanged((change) => editors.checkDisk(change.workspaceId, change.dirs));
    return () => { void unlisten.then((u) => u()); };
  }, []);

  // Files dropped from the file manager land at the caret of the active
  // document, wherever over the editor they were dropped (FIX-10).
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const activeId = ws ? editors.activeEditorId(ws) : null;
      if (event.payload.type !== "drop" || !activeId) return;
      void editors.doc(activeId)?.insertPaths(event.payload.paths);
    });
    return () => { void unlisten.then((u) => u()); };
  }, [ws]);

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
      const activeId = ws ? editors.activeEditorId(ws) : null;
      switch (action) {
        case "switch-workspace": openSwitcher(); break;
        case "focus-other-window": void api.focusWindow("terminal"); break;
        case "quick-open": void openQuickOpen(); break;
        case "search": focusPanel("search"); break;
        case "git": focusPanel("git"); break;
        case "files": focusPanel("files"); break;
        case "outline": focusPanel("outline"); break;
        case "settings": openSettings(); break;
        case "save": if (activeId) void editors.save(activeId).catch(report); break;
        case "close-editor": if (ws && activeId) void closeTab(ws, activeId); break;
        case "cycle-mode": if (activeId) editors.doc(activeId)?.cycleMode(); break;
        case "split-editor": if (ws) void api.splitEditor(ws.id).catch(report); break;
        case "move-editor": {
          // The next group in reading order, or a new one when there is no other (ED-42).
          if (!ws || !activeId) break;
          const order = groupOrder(ws);
          const i = order.indexOf(ws.activeGroup ?? "");
          const next = order.length > 1 ? order[(i + 1) % order.length] : "";
          void api.moveEditor(ws.id, activeId, next, null).catch(report);
          break;
        }
        case "next-tab": cycle(ws, 1); break;
        case "prev-tab": cycle(ws, -1); break;
        case "copy-relative-path": {
          const path = selected ?? (ws && activeId ? editors.activeGroup(ws)?.editors.find((t) => t.id === activeId)?.path : undefined);
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
    api.openFile(ws.id, path, true).then((id) => editors.revealLine(id, line, column)).catch(report);
  };

  // Quote to AI: a citation into the active document, whatever the link setting (CITE-01, CITE-05).
  const quote = (paths: string[]) => {
    const id = editors.activeEditorId(ws);
    const doc = id ? editors.doc(id) : undefined;
    if (!doc) { report("Open a document to quote into first."); return; }
    doc.insertCitation(paths);
  };

  // Files with work-tree changes or not yet tracked; what is only staged does not count (FIX-06).
  const unstaged = gitStatus.filter((s) => s.untracked || s.conflicted || s.worktree !== ".").length;

  const renderPanel = (id: PanelId) => {
    if (!ws.available) return <div className="tree-loading">The directory {ws.path} is missing.</div>;
    switch (id) {
      case "files": return <FileTree key={ws.id} ws={ws} selected={selected} onSelect={setSelected} onOpen={(p, preview) => void api.openFile(ws.id, p, preview).catch(report)} onQuote={quote} gitStatus={gitStatus} />;
      case "search": return <SearchPanel key={ws.id} ws={ws} onOpen={openAt} />;
      case "outline": return <Outline ws={ws} />;
      case "git": return <GitPanel key={ws.id} ws={ws} session={session} status={gitStatus} info={gitInfo} refresh={refreshGit} onDiff={(p, d) => void api.openDiff(ws.id, p, d).catch(report)} onOpenFile={(p) => void api.openFile(ws.id, p, true).catch(report)} />;
    }
  };

  return (
    <main className="workspace-main">
      <SplitTree<DockLeaf>
        node={layout.root}
        path={[]}
        keyOf={leafKey}
        renderLeaf={(leaf) =>
          leaf.kind === "editor" ? (
            <EditorLeaf layout={layout} update={update}><EditorArea ws={ws} onGitChanged={refreshGit} /></EditorLeaf>
          ) : (
            <RegionView region={leaf} layout={layout} update={update} unstaged={unstaged} render={renderPanel} />
          )
        }
        onResize={(path, sizes) => update(resizeSplit(layout, path, sizes))}
      />
      {quickOpen && (
        <Palette
          title="Open file"
          items={quickOpen}
          onClose={() => setQuickOpen(null)}
          onPick={(item) => { setQuickOpen(null); void api.openFile(ws.id, item.id, true).catch(report); }}
        />
      )}
    </main>
  );
}

/** The editor area as a dock leaf: panels dropped on its edges get a region beside it. */
function EditorLeaf({ layout, update, children }: { layout: PanelLayout; update: (l: PanelLayout) => void; children: React.ReactNode }) {
  const zone = useDropZone(
    (types) => types.includes(PANEL_MIME),
    (z, e) => update(dropPanel(layout, e.dataTransfer.getData(PANEL_MIME) as PanelId, "editor", z)),
    { edgesOnly: true },
  );
  return (
    <div className="editor-leaf" ref={zone.ref} {...zone.handlers}>
      {children}
      {zone.overlay}
    </div>
  );
}

/** One tabbed stack of panels. Its tabs are dragged to move a panel (DOCK-01). */
function RegionView({ region, layout, update, unstaged, render }: {
  region: Region;
  layout: PanelLayout;
  update: (l: PanelLayout) => void;
  unstaged: number;
  render: (id: PanelId) => React.ReactNode;
}) {
  const zone = useDropZone(
    (types) => types.includes(PANEL_MIME),
    (z, e) => update(dropPanel(layout, e.dataTransfer.getData(PANEL_MIME) as PanelId, region.id, z)),
    { ignore: (target) => !!target.closest(".sidebar-tabs") },
  );
  // A panel tab dropped on the strip lands at that position: the way to
  // reorder tabs, or to bring a panel over from another region.
  const [over, setOver] = useState<number | null>(null);
  const isPanel = (e: React.DragEvent) => e.dataTransfer.types.includes(PANEL_MIME);
  const dropAt = (e: React.DragEvent, index: number | null) => {
    const panel = e.dataTransfer.getData(PANEL_MIME) as PanelId;
    setOver(null);
    if (!panel) return;
    e.preventDefault();
    e.stopPropagation();
    update(placePanel(layout, panel, region.id, index));
  };
  return (
    <aside className="region" ref={zone.ref} {...zone.handlers}>
      <div
        className="sidebar-tabs"
        onDragOver={(e) => { if (isPanel(e)) { e.preventDefault(); e.stopPropagation(); setOver(region.panels.length); } }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => dropAt(e, null)}
      >
        {region.panels.map((id, i) => {
          const panel = PANELS.find((p) => p.id === id);
          return (
            <div
              key={id}
              role="tab"
              className={`${id === region.active ? "active" : ""}${over === i ? " drop-before" : ""}`}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData(PANEL_MIME, id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { if (isPanel(e)) { e.preventDefault(); e.stopPropagation(); setOver(i); } }}
              onDrop={(e) => dropAt(e, i)}
              onClick={() => update(setActivePanel(layout, region.id, id))}
              title={panel?.hotkey}
            >
              {panel?.label ?? id}{id === "git" && unstaged ? ` (${unstaged})` : ""}
            </div>
          );
        })}
        <button className="panel-hide" onClick={() => update(hidePanel(layout, region.active))} title="Hide this panel — the View menu or its hotkey brings it back">×</button>
      </div>
      {render(region.active)}
      {zone.overlay}
    </aside>
  );
}

function cycle(ws: Workspace | undefined, delta: number) {
  const group = ws ? editors.activeGroup(ws) : undefined;
  if (!ws || !group || group.editors.length === 0) return;
  const i = group.editors.findIndex((t) => t.id === group.activeEditor);
  const next = group.editors[(i + delta + group.editors.length) % group.editors.length];
  void api.setActiveEditor(ws.id, next.id);
}
