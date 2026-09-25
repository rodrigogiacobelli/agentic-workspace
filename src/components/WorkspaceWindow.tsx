import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, events } from "../api";
import * as editors from "../editors";
import { actionFor } from "../hotkeys";
import { Live, retainKept } from "../live";
import { pick } from "../modes";
import { report } from "../notice";
import * as repo from "../repo";
import * as settings from "../settings";
import type { AreaId, DiffSpec, DockedMode, PanelId, PanelLayout, PanelLayouts, Region, Session, WorkLeaf, Workspace } from "../types";
import { BranchesPanel } from "./BranchesPanel";
import { CommitPanel } from "./CommitPanel";
import { dropPanel, hidePanel, leafKey, normalizeAll, panelInfo, placePanel, resizeSplit, setActivePanel, showPanel, type DockLeaf } from "./dock";
import { EditorArea, activeGroupOf, areaOf, closeTab, groupOrder } from "./EditorArea";
import { FileTree } from "./FileTree";
import { HistoryPanel, showCommit } from "./HistoryPanel";
import { Icon } from "./icons";
import { ContextMenu } from "./Menu";
import { Outline } from "./Outline";
import { Palette, type PaletteItem } from "./Palette";
import { SearchPanel } from "./SearchPanel";
import { PANEL_MIME, SplitTree, useDropZone } from "./SplitTree";
import { TagsPanel } from "./TagsPanel";
import { WorktreesPanel } from "./WorktreesPanel";

interface Props {
  session: Session;
  openSwitcher: () => void;
  openSettings: () => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The working area a docked mode shows: the Editor's files, or Source Control's diffs. */
const areaFor = (mode: DockedMode): AreaId => (mode === "scm" ? "review" : "editor");

/** Files open in the Editor: a file asked for from anywhere brings the Editor forward. */
function openInEditor(ws: Workspace, path: string, preview: boolean): Promise<string> {
  if (ws.mode !== "editor") void api.setMode(ws.id, "editor").catch(report);
  return api.openFile(ws.id, path, preview);
}

export function WorkspaceWindow({ session, openSwitcher, openSettings }: Props) {
  const ws = session.workspaces.find((w) => w.id === session.active);
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const [quickOpen, setQuickOpen] = useState<PaletteItem[] | null>(null);
  /** The path each workspace's tree has selected, for the copy-path key. */
  const selection = useRef(new Map<string, string | null>());

  // The dock trees are the application's, kept with the settings; the
  // settings dialog can reset them or show a hidden panel from any window.
  const [layouts, setLayouts] = useState<PanelLayouts>(() => normalizeAll(settings.get()?.panelLayout));
  const layoutsRef = useRef(layouts);
  layoutsRef.current = layouts;
  useEffect(() => settings.subscribe((s) => {
    const next = normalizeAll(s.panelLayout);
    if (!same(next, layoutsRef.current)) setLayouts(next);
  }), []);
  const update = useCallback((mode: DockedMode, next: PanelLayout) => {
    if (same(next, layoutsRef.current[mode])) return;
    const all = { ...layoutsRef.current, [mode]: next };
    layoutsRef.current = all;
    setLayouts(all);
    void settings.update({ panelLayout: all }).catch(report);
  }, []);
  /** A panel's hotkey shows it wherever it sits, bringing its mode forward (DOCK-10). */
  const focusPanel = useCallback((id: PanelId) => {
    const info = panelInfo(id);
    const w = wsRef.current;
    if (!info || !w) return;
    if (w.mode !== info.mode) void api.setMode(w.id, info.mode).catch(report);
    update(info.mode, showPanel(layoutsRef.current[info.mode], id));
    window.dispatchEvent(new CustomEvent("panel-focus", { detail: { workspaceId: w.id, id } }));
  }, [update]);
  /** Something opened in a mode's working area comes to the front of it, over any panel shown there. */
  const front = useCallback((mode: DockedMode) => update(mode, setActivePanel(layoutsRef.current[mode], "work", null)), [update]);
  /** Files open in the Editor, in front of whatever panel its working area shows. */
  const openFile = useCallback((w: Workspace, path: string, preview: boolean) => {
    front("editor");
    return openInEditor(w, path, preview);
  }, [front]);

  // The repository store follows the workspace on screen.
  useEffect(() => { repo.show(session.active); }, [session.active]);

  // What a closed tab or a removed workspace left open or kept goes with it.
  useEffect(() => {
    const tabs = editors.allTabIds(session.workspaces);
    editors.retain(tabs);
    retainKept(new Set(session.workspaces.map((w) => w.id)), tabs);
    editors.follow(session.workspaces);
  }, [session]);

  // Links inside documents open files here; notices surface here.
  useEffect(() => {
    editors.setHooks({
      openFile: (rel) => { if (ws) void openFile(ws, rel, true).catch(report); },
      notice: (m) => report(m),
      showCommit: (hash) => {
        if (!ws) return;
        focusPanel("history");
        showCommit(ws.id, hash);
      },
    });
  }, [ws, focusPanel, openFile]);

  // A terminal link or a notification asked for a file at a line.
  useEffect(() => {
    const unlisten = events.onOpenAt(async (t) => {
      if (t.workspaceId !== session.active) await api.switchWorkspace(t.workspaceId).catch(report);
      await api.setMode(t.workspaceId, "editor").catch(report);
      front("editor");
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
      const w = wsRef.current;
      const activeId = w && w.mode === "editor" ? editors.activeEditorId(w) : null;
      if (event.payload.type !== "drop" || !activeId) return;
      void editors.doc(activeId)?.insertPaths(event.payload.paths);
    });
    return () => { void unlisten.then((u) => u()); };
  }, []);

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
      // Tab keys act on the working area of the mode on screen.
      const area = areaFor(ws?.mode ?? "editor");
      const activeId = ws ? activeGroupOf(ws, area)?.activeEditor ?? null : null;
      switch (action) {
        case "switch-workspace": openSwitcher(); break;
        case "focus-other-window": void api.focusWindow("terminal"); break;
        case "mode-editor": void pick(ws, "editor", "workspace").catch(report); break;
        case "mode-scm": void pick(ws, "scm", "workspace").catch(report); break;
        case "mode-terminal": void pick(ws, "terminal", "workspace").catch(report); break;
        case "quick-open": void openQuickOpen(); break;
        case "search": focusPanel("search"); break;
        case "git": focusPanel("commit"); break;
        case "explorer": focusPanel("explorer"); break;
        case "outline": focusPanel("outline"); break;
        case "settings": openSettings(); break;
        case "save": if (activeId) void editors.save(activeId).catch(report); break;
        case "close-editor": if (ws && activeId) void closeTab(ws, activeId); break;
        case "cycle-mode": if (activeId) editors.doc(activeId)?.cycleMode(); break;
        case "split-editor": if (ws) void api.splitEditor(ws.id, area).catch(report); break;
        case "move-editor": {
          // The next group in reading order, or a new one when there is no other (ED-42).
          if (!ws || !activeId) break;
          const state = areaOf(ws, area);
          const order = groupOrder(state);
          const i = order.indexOf(state.activeGroup ?? "");
          const next = order.length > 1 ? order[(i + 1) % order.length] : "";
          void api.moveEditor(ws.id, activeId, next, null).catch(report);
          break;
        }
        case "next-tab": cycle(ws, area, 1); break;
        case "prev-tab": cycle(ws, area, -1); break;
        case "copy-relative-path": {
          // The tree's selection is on screen only in the Editor.
          const tree = ws?.mode === "editor" ? selection.current.get(ws.id) : null;
          const path = tree ?? (ws && activeId ? activeGroupOf(ws, area)?.editors.find((t) => t.id === activeId)?.path : undefined);
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

  return (
    <main className="workspace-main">
      {ws ? (
        <WorkspaceView
          key={ws.id}
          ws={ws}
          session={session}
          layouts={layouts}
          update={update}
          front={front}
          openFile={openFile}
          selection={selection.current}
        />
      ) : (
        <div className="empty">Add a folder to start.</div>
      )}
      {quickOpen && ws && (
        <Palette
          title="Open file"
          items={quickOpen}
          onClose={() => setQuickOpen(null)}
          onPick={(item) => { setQuickOpen(null); void openFile(ws, item.id, true).catch(report); }}
        />
      )}
    </main>
  );
}

interface ViewProps {
  ws: Workspace;
  session: Session;
  layouts: PanelLayouts;
  update: (mode: DockedMode, next: PanelLayout) => void;
  front: (mode: DockedMode) => void;
  openFile: (ws: Workspace, path: string, preview: boolean) => Promise<string>;
  selection: Map<string, string | null>;
}

/**
 * The workspace on screen, in the mode it is in. Only that workspace and that
 * mode are mounted: switching either builds the view again, and it comes back
 * as it was left. The documents, their cursors and their undo history live in
 * the editor registry; the lists, drafts and scroll offsets of the panels and
 * diffs are kept in `src/live.ts`, so a rebuilt view paints from them at once
 * and re-reads after.
 */
function WorkspaceView({ ws, session, layouts, update, front, openFile, selection }: ViewProps) {
  const [selected, setSelected] = useState<string | null>(() => selection.get(ws.id) ?? null);
  const select = (path: string | null) => { selection.set(ws.id, path); setSelected(path); };
  const { status } = repo.useRepo(ws.id);

  const openAt = (path: string, line: number, column: number) => {
    openFile(ws, path, true).then((id) => editors.revealLine(id, line, column)).catch(report);
  };

  // A single click previews and the tree keeps its focus, so Ctrl+C and the
  // other tree keys still reach it; a double click or Enter opens for keeps
  // and hands focus to the document.
  const openFromTree = (path: string, preview: boolean) => {
    front("editor");
    if (!preview) (document.activeElement as HTMLElement | null)?.blur();
    api.openFile(ws.id, path, preview).then((id) => { if (!preview) editors.doc(id)?.focus(); }).catch(report);
  };

  // Quote to AI: a citation into the active document, whatever the link setting (CITE-01, CITE-05).
  const quote = (paths: string[]) => {
    const id = editors.activeEditorId(ws);
    const doc = id ? editors.doc(id) : undefined;
    if (!doc) { report("Open a document to quote into first."); return; }
    doc.insertCitation(paths);
  };

  const onDiff = (path: string, diff: DiffSpec) => { front("scm"); void api.openDiff(ws.id, path, diff).catch(report); };
  const onOpenFile = (path: string) => void openFile(ws, path, true).catch(report);

  const renderPanel = (id: PanelId) => {
    if (!ws.available) return <div className="tree-loading">The directory {ws.path} is missing.</div>;
    switch (id) {
      case "explorer": return <FileTree key="explorer" kind="explorer" ws={ws} selected={selected} onSelect={select} onOpen={openFromTree} onQuote={quote} gitStatus={status} />;
      case "custom": return <FileTree key="custom" kind="custom" ws={ws} selected={selected} onSelect={select} onOpen={openFromTree} onQuote={quote} gitStatus={status} />;
      case "search": return <SearchPanel ws={ws} onOpen={openAt} />;
      case "outline": return <Outline ws={ws} />;
      case "commit": return <CommitPanel ws={ws} onDiff={onDiff} onOpenFile={onOpenFile} />;
      case "history": return <HistoryPanel ws={ws} onDiff={onDiff} />;
      case "branches": return <BranchesPanel ws={ws} session={session} />;
      case "worktrees": return <WorktreesPanel ws={ws} session={session} />;
      case "tags": return <TagsPanel ws={ws} />;
    }
  };

  const mode = ws.mode;
  const layout = layouts[mode];
  const set = (next: PanelLayout) => update(mode, next);
  return (
    <div className="workspace-view">
      {/* Keyed by the mode: the two trees share region ids, and one must not inherit the other's panels. */}
      <div key={mode} className="mode-view">
        <SplitTree<DockLeaf>
          node={layout.root}
          path={[]}
          keyOf={leafKey}
          renderLeaf={(leaf) =>
            leaf.kind === "work" ? (
              <WorkLeafView ws={ws} mode={mode} leaf={leaf} layout={layout} update={set} unstaged={repo.unstagedCount(status)} openFile={openFile} render={renderPanel} />
            ) : (
              <RegionView workspaceId={ws.id} mode={mode} region={leaf} layout={layout} update={set} unstaged={repo.unstagedCount(status)} render={renderPanel} />
            )
          }
          onResize={(path, sizes) => set(resizeSplit(layout, path, sizes))}
        />
      </div>
    </div>
  );
}

/** The panel a drag carries, when it belongs to this mode's tree. */
function draggedPanel(e: React.DragEvent, mode: DockedMode): PanelId | null {
  const id = e.dataTransfer.getData(PANEL_MIME) as PanelId;
  return panelInfo(id)?.mode === mode ? id : null;
}

/**
 * The working area as a dock leaf. An edge makes a region beside it; the
 * centre, or its tab strip, takes the panel as one of its own tabs.
 */
function WorkLeafView({ ws, mode, leaf, layout, update, unstaged, openFile, render }: {
  ws: Workspace;
  mode: DockedMode;
  leaf: WorkLeaf;
  layout: PanelLayout;
  update: (l: PanelLayout) => void;
  unstaged: number;
  openFile: (ws: Workspace, path: string, preview: boolean) => Promise<string>;
  render: (id: PanelId) => React.ReactNode;
}) {
  const zone = useDropZone(
    (types) => types.includes(PANEL_MIME),
    (z, e) => { const id = draggedPanel(e, mode); if (id) update(dropPanel(layout, id, "work", z)); },
    { centerOver: (target) => !!target.closest(".tab-bar") },
  );
  return (
    <div className="work-leaf" ref={zone.ref} {...zone.handlers}>
      <EditorArea
        ws={ws}
        area={areaFor(mode)}
        panels={{
          ids: leaf.panels,
          active: leaf.active,
          // A panel's tab asks it for the keyboard, as a region's tab does.
          onPick: (id) => {
            update(setActivePanel(layout, "work", id));
            if (id) window.dispatchEvent(new CustomEvent("panel-focus", { detail: { workspaceId: ws.id, id } }));
          },
          onHide: (id) => update(hidePanel(layout, id)),
          unstaged,
          render,
        }}
        onOpenInEditor={(path) => void openFile(ws, path, false).catch(report)}
      />
      {zone.overlay}
    </div>
  );
}

/** One tabbed stack of panels. Its tabs are dragged to move a panel (DOCK-01). */
function RegionView({ workspaceId, mode, region, layout, update, unstaged, render }: {
  workspaceId: string;
  mode: DockedMode;
  region: Region;
  layout: PanelLayout;
  update: (l: PanelLayout) => void;
  unstaged: number;
  render: (id: PanelId) => React.ReactNode;
}) {
  const zone = useDropZone(
    (types) => types.includes(PANEL_MIME),
    (z, e) => { const id = draggedPanel(e, mode); if (id) update(dropPanel(layout, id, region.id, z)); },
    { ignore: (target) => !!target.closest(".sidebar-tabs") },
  );
  // A panel tab dropped on the strip lands at that position: the way to
  // reorder tabs, or to bring a panel over from another region.
  const [over, setOver] = useState<number | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: PanelId } | null>(null);
  const isPanel = (e: React.DragEvent) => e.dataTransfer.types.includes(PANEL_MIME);
  const dropAt = (e: React.DragEvent, index: number | null) => {
    const panel = draggedPanel(e, mode);
    setOver(null);
    if (!panel) return;
    e.preventDefault();
    e.stopPropagation();
    update(placePanel(layout, panel, region.id, index));
  };
  const active = panelInfo(region.active);
  // A tab shown once stays mounted behind the others, idling, for as long as
  // its mode is on screen: a look at another tab and back rebuilds nothing.
  // Once the mode goes, each panel comes back from what it kept.
  const [seen, setSeen] = useState<PanelId[]>([region.active]);
  useEffect(() => { setSeen((s) => (s.includes(region.active) ? s : [...s, region.active])); }, [region.active]);
  return (
    <aside className="region" ref={zone.ref} {...zone.handlers}>
      <div
        className="sidebar-tabs"
        onDragOver={(e) => { if (isPanel(e)) { e.preventDefault(); e.stopPropagation(); setOver(region.panels.length); } }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => dropAt(e, null)}
      >
        {region.panels.map((id, i) => {
          const info = panelInfo(id);
          return (
            <div
              key={id}
              role="tab"
              className={`${id === region.active ? "active" : ""}${over === i ? " drop-before" : ""}`}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData(PANEL_MIME, id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { if (isPanel(e)) { e.preventDefault(); e.stopPropagation(); setOver(i); } }}
              onDrop={(e) => dropAt(e, i)}
              onClick={() => {
                update(setActivePanel(layout, region.id, id));
                window.dispatchEvent(new CustomEvent("panel-focus", { detail: { workspaceId, id } }));
              }}
              onContextMenu={(e) => { e.preventDefault(); setTabMenu({ x: e.clientX, y: e.clientY, id }); }}
              title={info?.hotkey ? `${info.label} (${info.hotkey})` : info?.label ?? id}
            >
              <span className="tab-glyph">{info && <Icon name={info.icon} />}</span>
              <span className="tab-word">{info?.label ?? id}</span>
              {id === "commit" && unstaged > 0 && <span className="tab-count">{unstaged}</span>}
            </div>
          );
        })}
      </div>
      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} anchor={tabMenu} onClose={() => setTabMenu(null)}>
          <button onClick={() => { update(hidePanel(layout, tabMenu.id)); setTabMenu(null); }}>Hide {panelInfo(tabMenu.id)?.label ?? tabMenu.id}</button>
        </ContextMenu>
      )}
      {/* The tab says the panel's name only in words; drawn as a glyph, the panel carries it. */}
      <div className="panel-title">{active?.label}</div>
      {region.panels.filter((id) => id === region.active || seen.includes(id)).map((id) => (
        <div key={id} className="panel-slot" hidden={id !== region.active}>
          <Live.Provider value={id === region.active}>{render(id)}</Live.Provider>
        </div>
      ))}
      {zone.overlay}
    </aside>
  );
}

function cycle(ws: Workspace | undefined, area: AreaId, delta: number) {
  const group = ws ? activeGroupOf(ws, area) : undefined;
  if (!ws || !group || group.editors.length === 0) return;
  const i = group.editors.findIndex((t) => t.id === group.activeEditor);
  const next = group.editors[(i + delta + group.editors.length) % group.editors.length];
  void api.setActiveEditor(ws.id, next.id);
}
