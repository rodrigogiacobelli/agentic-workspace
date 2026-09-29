import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { firstFile, offerDrop, treeDrag } from "../dropRoute";
import * as editors from "../editors";
import { MODES, type Mode } from "../editor/document";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Live, keep, peek } from "../live";
import { notify, report } from "../notice";
import type { AreaId, EditorGroup, EditorTab, LayoutGroup, PanelId, WorkArea, Workspace } from "../types";
import { DiffView } from "./DiffView";
import { panelInfo } from "./dock";
import { Icon } from "./icons";
import { ContextMenu } from "./Menu";
import { PANEL_MIME, SplitTree, useDropZone, zoneAt, type Zone } from "./SplitTree";
import { dragTab, settleTabDrag, TabOverflow, useTabStrip, type TabZone } from "./tabs";

/** A working area's groups: the Editor's sit on the workspace itself, Source Control's under `review`. */
export function areaOf(ws: Workspace, area: AreaId): WorkArea {
  return area === "review" ? ws.review : ws;
}

export function activeGroupOf(ws: Workspace, area: AreaId): EditorGroup | undefined {
  const a = areaOf(ws, area);
  return a.groups.find((g) => g.id === a.activeGroup) ?? a.groups[0];
}

export async function closeTab(ws: Workspace, id: string): Promise<void> {
  const dirty = editors.isDirty(id) ? editors.doc(id) : undefined;
  if (dirty) {
    const path = ws.groups.flatMap((g) => g.editors).find((t) => t.id === id)?.path ?? "this file";
    const discard = await ask(`${path} has unsaved changes. Close it and discard them?`, {
      title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep open",
    });
    if (!discard) return;
  }
  await api.closeFile(ws.id, id);
  // Discarded stays discarded: the draft kept against a crash would lay the
  // changes over the file the next time it opens.
  dirty?.dropDraft();
}

/** What a tab reads: the file name, marked when the tab shows a diff of it. */
export function tabLabel(tab: EditorTab): string {
  const name = tab.path.split("/").pop() ?? tab.path;
  if (!tab.diff) return name;
  if (tab.diff.kind === "commit") return `${name} (${tab.diff.hash?.slice(0, 7) ?? "commit"})`;
  return `${name} (${tab.diff.kind === "staged" ? "staged" : tab.diff.untracked ? "untracked" : "changes"})`;
}

/** Group ids in reading order: left to right, top to bottom. */
export function groupOrder(area: WorkArea): string[] {
  const out: string[] = [];
  const walk = (node: WorkArea["layout"]) => {
    if (node.kind === "group") out.push(node.id);
    else node.children.forEach(walk);
  };
  walk(area.layout);
  return out;
}

/**
 * Panels dropped on the working area's centre. They are tabs of the area's
 * first group, in front of its files or diffs, and one of them shown takes
 * that group's body until a file or diff tab is picked again.
 */
export interface WorkPanels {
  ids: PanelId[];
  active: PanelId | null;
  onPick: (id: PanelId | null) => void;
  onHide: (id: PanelId) => void;
  /** The Commit tab's count of unstaged files (FIX-06). */
  unstaged: number;
  render: (id: PanelId) => ReactNode;
}

interface AreaProps {
  ws: Workspace;
  area: AreaId;
  panels: WorkPanels;
  /** Opens the file a diff is of, in the Editor. */
  onOpenInEditor: (path: string) => void;
}

/** A mode's groups of tabs, arranged by the area's layout tree (ED-40). */
export function EditorArea({ ws, area, panels, onOpenInEditor }: AreaProps) {
  const state = areaOf(ws, area);
  const host = groupOrder(state)[0];
  // Set once the area's groups are built: a group mounting before then is the
  // area coming back on screen, one mounting after is a group split off.
  // Children's effects run first, so theirs see this still false, and strict
  // mode's second mount sees it false again.
  const settled = useRef(false);
  useLayoutEffect(() => {
    settled.current = true;
    return () => { settled.current = false; };
  }, []);
  // The split zone a dragged tab is over, drawn by the group it belongs to.
  const [tabZone, setTabZone] = useState<TabZone | null>(null);
  return (
    <section className="editor-area">
      <SplitTree<LayoutGroup>
        node={state.layout}
        path={[]}
        keyOf={(leaf) => leaf.id}
        renderLeaf={(leaf) => {
          const group = state.groups.find((g) => g.id === leaf.id);
          return group ? (
            <GroupView
              ws={ws}
              area={area}
              group={group}
              active={group.id === state.activeGroup || state.groups.length === 1}
              panels={group.id === host ? panels : null}
              settled={settled}
              tabZone={tabZone?.group === group.id ? tabZone.zone : null}
              onTabZone={setTabZone}
              onOpenInEditor={onOpenInEditor}
            />
          ) : null;
        }}
        onResize={(path, sizes) => void api.setLayoutSizes(ws.id, area, path, sizes)}
      />
    </section>
  );
}

function GroupView({ ws, area, group, active, panels, settled, tabZone, onTabZone, onOpenInEditor }: {
  ws: Workspace;
  area: AreaId;
  group: EditorGroup;
  active: boolean;
  panels: WorkPanels | null;
  /** Whether the area had been built before this render; see `EditorArea`. */
  settled: React.RefObject<boolean>;
  /** The zone of this group a dragged tab is over. */
  tabZone: Zone | null;
  onTabZone: (zone: TabZone | null) => void;
  onOpenInEditor: (path: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const shownRef = useRef<string | null>(null);
  const [, bump] = useState(0);
  const [panelMenu, setPanelMenu] = useState<{ x: number; y: number; id: PanelId } | null>(null);
  const activeId = group.activeEditor;
  const tab = group.editors.find((t) => t.id === activeId);
  const shownPanel = panels?.active ?? null;
  // A panel shown once stays mounted behind the files, idling, as a region's
  // tabs do.
  const [seen, setSeen] = useState<PanelId[]>([]);
  useEffect(() => { if (shownPanel) setSeen((s) => (s.includes(shownPanel) ? s : [...s, shownPanel])); }, [shownPanel]);
  // A tab that becomes active by any path — opened, cycled to, left in front
  // by a close — comes out from behind a panel shown over the group.
  const lastActive = useRef(activeId);
  useEffect(() => {
    if (lastActive.current !== activeId && activeId && shownPanel) panels?.onPick(null);
    lastActive.current = activeId;
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const strip = useTabStrip(shownPanel ?? activeId, group.editors.length + (panels?.ids.length ?? 0));
  const entry = tab && !tab.diff ? editors.get(tab.id) : undefined;
  const doc = entry && "doc" in entry ? entry.doc : undefined;
  const media = entry && "media" in entry ? entry.media : null;

  // A file dragged from a tree onto the group: the centre opens it, an edge
  // splits the group and opens it there (ED-41), except on the centre of a
  // Markdown document, where a reference to it is written at the drop point
  // (TREE-16, D7). Files open in the Editor only. The tab strip handles its
  // own drops. A tab is dragged by the pointer, not natively: `dragEditor`
  // below finds the zone it is over, and the area hands it back here to draw
  // (`tabZone`).
  const zone = useDropZone(
    () => false,
    () => {},
    {
      // A tree docked in the group keeps its own drags: a spot it refuses
      // takes nothing, rather than opening the file here.
      ignore: (target) => !!target.closest(".tab-bar, .sidebar-body"),
      tree: area === "editor" ? {
        insertsAtCentre: () => !shownPanel && !!doc?.isMarkdown,
        onDrop: (z, x, y, drag, inserts) => {
          if (inserts) doc?.insertReference(drag.paths.map((p) => (drag.dirs.has(p) ? `${p}/` : p)), x, y);
          else void api.dropEditor(ws.id, { path: firstFile(drag) }, group.id, z, null).catch(report);
        },
      } : undefined,
    },
  );

  // Dirty marks and banners follow the documents.
  useEffect(() => editors.subscribe(() => bump((n) => n + 1)), []);

  // Mounts when the active tab changes or its document was dropped from the
  // registry — never on every session update, which would refocus the editor
  // while something else is being typed into. Both run in the layout phase: a
  // rebuilt group paints with its document already in it, and a group going
  // away takes its document off before React detaches it, while the document
  // can still read where it was scrolled.
  //
  // Focus goes to a document brought forward: a tab picked here, a group
  // split off, a group built for the first time this session — at launch, or
  // on a workspace's first visit — or a tab opened while the group was away,
  // a file opened from Source Control. A group rebuilt with the tab it had in
  // front, its workspace or its mode coming back, leaves focus where it is.
  // What it had in front is read once, as it is built.
  const frontKey = `${ws.id}:group:${group.id}:front`;
  const [frontBefore] = useState(() => peek<string | null>(frontKey));
  const mounted = activeId ? !!editors.get(activeId) : false;
  useLayoutEffect(() => {
    const container = host.current;
    if (shownRef.current && shownRef.current !== activeId && container) editors.unmount(shownRef.current, container);
    shownRef.current = tab && !tab.diff ? activeId : null;
    const focus = settled.current || frontBefore !== activeId;
    keep(frontKey, activeId);
    if (tab && !tab.diff && container) void editors.mount(ws, tab, container, focus).catch(report);
  }, [activeId, ws.id, mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const container = host.current;
    return () => { if (shownRef.current && container) editors.unmount(shownRef.current, container); };
  }, []);

  // A tab dragged along a strip lands in the slot under the pointer — its own
  // strip's or another group's (TAB-09, TAB-12); dragged over a group's
  // working area it joins the group at the centre or splits it at an edge
  // (ED-36, ED-37), and the centre of its own group takes nothing.
  const dragEditor = (e: React.PointerEvent<HTMLElement>, id: string) => dragTab(e, {
    tabsOf: editorTabs,
    hit: (x, y) => {
      const under = document.elementFromPoint(x, y);
      const target = under?.closest<HTMLElement>(".editor-group[data-group]");
      if (!under || !target) return null;
      if (under.closest(".tab-bar")) return { strip: target.querySelector<HTMLElement>(":scope > .tab-bar > .tabs")! };
      const z = zoneAt(target.getBoundingClientRect(), x, y);
      return z === "center" && target === zone.ref.current ? null : { zone: { group: target.dataset.group!, zone: z } };
    },
    showZone: onTabZone,
    drop: (to) => {
      if ("zone" in to) return api.dropEditor(ws.id, { editor: id }, to.zone.group, to.zone.zone, null).catch(report);
      const target = to.strip.closest<HTMLElement>("[data-group]")!.dataset.group!;
      if (target === group.id) return api.reorderEditors(ws.id, group.id, to.order, id).catch(report);
      return api.moveEditor(ws.id, id, target, to.index).catch(report);
    },
  });
  // The strip's tabs changing is a dropped tab's move arriving.
  useLayoutEffect(settleTabDrag, [group.editors.map((t) => t.id).join("\n")]);
  // A file dragged from a tree onto the strip opens at that position; the
  // router runs the offer at the drop.
  const acceptsFile = (e: React.DragEvent, index: number | null) => {
    const drag = area === "editor" ? treeDrag() : null;
    const file = drag && !drag.missing ? firstFile(drag) : undefined;
    if (file) offerDrop(e, () => void api.dropEditor(ws.id, { path: file }, group.id, "center", index).catch(report));
  };
  const pickTab = (id: string) => {
    if (shownPanel) panels?.onPick(null);
    void api.setActiveEditor(ws.id, id);
  };

  return (
    <div
      ref={zone.ref}
      {...zone.handlers}
      className={`editor-group${active ? " active" : ""}`}
      data-group={group.id}
      onMouseDownCapture={() => { if (areaOf(ws, area).activeGroup !== group.id) void api.setActiveGroup(ws.id, group.id); }}
    >
      <div className="tab-bar">
        <div className="tabs" ref={strip.ref} onWheel={strip.onWheel} onDragOver={(e) => acceptsFile(e, null)}>
          {panels?.ids.map((id) => {
            const info = panelInfo(id);
            return (
              <div
                key={id}
                data-tab={id}
                className={`tab panel-tab${id === shownPanel ? " active" : ""}`}
                draggable
                onDragStart={(e) => { e.dataTransfer.setData(PANEL_MIME, id); e.dataTransfer.effectAllowed = "move"; }}
                onClick={() => panels.onPick(id)}
                onContextMenu={(e) => { e.preventDefault(); setPanelMenu({ x: e.clientX, y: e.clientY, id }); }}
                title={info?.label ?? id}
              >
                <span className="tab-glyph">{info && <Icon name={info.icon} size={14} />}</span>
                <span className="tab-label tab-word">{info?.label ?? id}</span>
                {id === "commit" && panels.unstaged > 0 && <span className="tab-count">{panels.unstaged}</span>}
                <button className="tab-close" onClick={(e) => { e.stopPropagation(); panels.onHide(id); }} title={`Hide ${info?.label ?? id}`}>×</button>
              </div>
            );
          })}
          {group.editors.map((t, i) => (
            <div
              key={t.id}
              data-tab={t.id}
              className={`tab${t.id === activeId && !shownPanel ? " active" : ""}${editors.doc(t.id)?.detached ? " detached" : ""}${t.preview ? " preview" : ""}`}
              onPointerDown={(e) => dragEditor(e, t.id)}
              onDragOver={(e) => acceptsFile(e, i)}
              onClick={() => pickTab(t.id)}
              onDoubleClick={() => { if (t.preview) void api.pinEditor(ws.id, t.id); }}
              title={t.preview ? `${t.path} (preview — double-click to keep)` : t.path}
            >
              <span className="tab-label">{editors.isDirty(t.id) ? "● " : ""}{tabLabel(t)}</span>
              <button className="tab-close" onClick={(e) => { e.stopPropagation(); void closeTab(ws, t.id); }} title="Close (Ctrl+W)">×</button>
            </div>
          ))}
          <span className="tabs-spacer" />
        </div>
        <TabOverflow
          strip={strip}
          entries={[
            ...(panels?.ids ?? []).map((id) => ({ id, label: panelInfo(id)?.label ?? id, active: id === shownPanel })),
            ...group.editors.map((t) => ({ id: t.id, label: tabLabel(t), active: t.id === activeId && !shownPanel })),
          ]}
          onPick={(id) => { if (panels?.ids.includes(id as PanelId)) panels.onPick(id as PanelId); else pickTab(id); }}
        />
        <button className="tab-add" onClick={() => void api.splitEditor(ws.id, area).catch(report)} title="Split (Ctrl+\)">⫿</button>
      </div>
      {panelMenu && panels && (
        <ContextMenu x={panelMenu.x} y={panelMenu.y} anchor={panelMenu} onClose={() => setPanelMenu(null)}>
          <button onClick={() => { panels.onHide(panelMenu.id); setPanelMenu(null); }}>Hide {panelInfo(panelMenu.id)?.label ?? panelMenu.id}</button>
        </ContextMenu>
      )}
      {panels?.ids.filter((id) => id === shownPanel || seen.includes(id)).map((id) => (
        <div key={id} className="work-panel" hidden={id !== shownPanel}>
          {/* The tab says the panel's name only in words; drawn as a glyph, the panel carries it. */}
          <div className="panel-title">{panelInfo(id)?.label}</div>
          <Live.Provider value={id === shownPanel}>{panels.render(id)}</Live.Provider>
        </div>
      ))}
      <div className="group-body" hidden={!!shownPanel}>
        {/* Behind a panel shown over the group, a diff idles as a panel behind a tab does. */}
        <Live.Provider value={!shownPanel}>
          {tab?.diff ? (
            <DiffView key={tab.id} ws={ws} tab={tab} onClose={() => void closeTab(ws, tab.id)} onOpenInEditor={() => onOpenInEditor(tab.path)} />
          ) : (
            <>
              {tab && <Breadcrumbs ws={ws} path={tab.path} doc={doc} />}
              {doc && <Banner doc={doc} />}
              <div className="editor-host" ref={host} hidden={!!media || area === "review"}>
                {group.editors.length === 0 && area === "editor" && <div className="empty">Open a file from the tree, or press Ctrl+P.</div>}
              </div>
              {group.editors.length === 0 && area === "review" && (
                <div className="empty">Pick a change in Commit, or a file of a commit in History, to see its diff here.</div>
              )}
              {media && tab && <MediaView ws={ws} path={tab.path} kind={media} />}
              {entry && "binary" in entry && tab && (
                <div className="binary-notice">
                  <p>{tab.path} is not a text file.</p>
                  <button onClick={() => void api.openExternally(ws.id, tab.path).catch(report)}>Open with the default application</button>
                </div>
              )}
            </>
          )}
        </Live.Provider>
      </div>
      {zone.overlay ?? (tabZone && <div className={`drop-zone drop-${tabZone}`} />)}
    </div>
  );
}

/** A strip's editor tabs: the panel tabs in front of them are dragged natively, into the dock. */
function editorTabs(strip: HTMLElement): HTMLElement[] {
  return Array.from(strip.querySelectorAll<HTMLElement>(":scope > [data-tab]:not(.panel-tab)"));
}

/** An image, an audio file or a video opened from the tree, shown as itself. */
function MediaView({ ws, path, kind }: { ws: Workspace; path: string; kind: "image" | "audio" | "video" }) {
  const url = convertFileSrc(`${ws.path}/${path}`);
  return (
    <div className="media-view">
      {kind === "image" && <img src={url} alt={path} title={path} />}
      {kind === "audio" && <audio src={url} controls title={path} />}
      {kind === "video" && <video src={url} controls title={path} />}
    </div>
  );
}

/** Cut shorter than this, the deepest heading says nothing, and the trail goes. */
const HEADING_FLOOR = 48;

/**
 * Whether the header row shows all it holds: its last item — the mode switch,
 * or the last crumb — ends inside the row's padding, and the deepest heading,
 * when it is cut short, still shows a few letters.
 */
function fits(row: HTMLElement): boolean {
  const end = row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight);
  if ((row.lastElementChild?.getBoundingClientRect().right ?? 0) > end + 0.5) return false;
  const deepest = row.querySelector<HTMLElement>(".heading.fit > span");
  return !deepest || deepest.scrollWidth <= deepest.clientWidth || deepest.clientWidth >= HEADING_FLOOR;
}

/**
 * The path from the workspace to the file, then the headings around the
 * cursor. A crumb of the path copies the path up to itself, from the
 * workspace's root, and its menu reveals it in the Explorer or copies it
 * whole (ED-47); the workspace's own crumb, whose relative path is empty,
 * copies the absolute root. A heading crumb jumps to its heading.
 *
 * A row too narrow for all of it keeps the mode switch whole at its right and
 * gives way a step at a time (ED-56): the deepest heading shortens, then the
 * heading trail goes (level 1); the folders fold into one `…` crumb (2), which
 * the workspace joins (3); last, the file name shortens. `…` opens a menu of
 * the crumbs it holds, whose rows act as the crumbs themselves do — a click
 * copies, a right-click opens the crumb's menu in the list's place — and a
 * crumb's tooltip carries its full text (ED-57).
 */
function Breadcrumbs({ ws, path, doc }: { ws: Workspace; path: string; doc?: import("../editor/document").Doc }) {
  // One menu at a time: the list `…` opens, which has no `path`, or a crumb's.
  const [menu, setMenu] = useState<{ x: number; y: number; path?: string } | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const segments = path.split("/");
  const trail = doc?.headingTrail() ?? [];
  const copy = (text: string) => void api.copyText(text).then(() => notify(`Copied ${text}`)).catch(report);
  const crumbMenu = (rel: string) => rel ? (e: React.MouseEvent) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, path: rel }); } : undefined;
  const crumbs = [{ name: ws.name, rel: "" }, ...segments.map((name, i) => ({ name, rel: segments.slice(0, i + 1).join("/") }))];
  // A change to what the row holds, or to its width, starts over from nothing
  // folded; each step is laid out and measured before the paint. A keystroke
  // that leaves the heading trail as it was measures nothing.
  const shape = [width, ws.name, path, !!doc?.isMarkdown, ...trail.map((h) => h.text)].join("\n");
  const [fold, setFold] = useState({ shape, level: 0 });
  const level = fold.shape === shape ? fold.level : 0;
  useLayoutEffect(() => {
    if (level < 3 && row.current && !fits(row.current)) setFold({ shape, level: level + 1 });
  }, [shape, level]);
  // The group is resized by a divider as often as by the window.
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const folded = level < 2 ? [] : crumbs.slice(level < 3 ? 1 : 0, -1);
  const listed = !!menu && menu.path === undefined;
  // The row unfolded under an open list: the list closes rather than coming
  // back at its old place when the row next folds.
  useEffect(() => { if (listed && folded.length === 0) setMenu(null); }, [listed, folded.length]);
  return (
    // WebKitGTK gives a button the focus when it is clicked; a press on a
    // crumb, or on a row of its menus, leaves it, and so the cursor, in the
    // text, and no autosave runs on the blur.
    <div ref={row} className="breadcrumbs" onMouseDown={(e) => { if ((e.target as Element).closest(".crumb, .menu")) e.preventDefault(); }}>
      {crumbs.map((c, i) => folded.includes(c) ? c === folded[0] && (
        <button
          key="folded"
          className="crumb"
          title={folded.map((f) => f.name).join(" › ")}
          aria-haspopup="menu"
          aria-expanded={listed}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu(listed ? null : { x: r.left, y: r.bottom + 2 });
          }}
        >
          …
        </button>
      ) : (
        <button
          key={i}
          className={`crumb${level === 3 && i === crumbs.length - 1 ? " fit" : ""}`}
          title={`Copy ${c.rel || ws.path}`}
          onClick={() => copy(c.rel || ws.path)}
          onContextMenu={crumbMenu(c.rel)}
        >
          <span>{c.name}</span>
        </button>
      ))}
      {level === 0 && trail.map((h, i) => (
        <button key={`h${i}`} className={`crumb heading${i === trail.length - 1 ? " fit" : ""}`} title={`Jump to ${h.text}`} onClick={() => doc?.jumpTo(h.from)}>
          <span>{h.text}</span>
        </button>
      ))}
      {doc?.isMarkdown && (
        <span className="mode-switch">
          {MODES.map((m: Mode) => (
            <button key={m} className={doc.mode === m ? "active" : ""} onClick={() => doc.setMode(m)} title="Cycle with Ctrl+E">{m}</button>
          ))}
        </span>
      )}
      {menu && (menu.path !== undefined || folded.length > 0) && (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu} onClose={() => setMenu(null)}>
          {menu.path === undefined ? folded.map((f) => (
            <button key={f.rel} title={`Copy ${f.rel || ws.path}`} onClick={() => { copy(f.rel || ws.path); setMenu(null); }} onContextMenu={crumbMenu(f.rel)}>{f.name}</button>
          )) : (
            <>
              {/* The workspace window opens the folders above it, selects it and brings the Explorer forward. */}
              <button onClick={() => { window.dispatchEvent(new CustomEvent("tree-reveal", { detail: { workspaceId: ws.id, path: menu.path } })); setMenu(null); }}>Reveal in Explorer</button>
              <button onClick={() => { copy(`${ws.path}/${menu.path}`); setMenu(null); }}>Copy absolute path</button>
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
}

function Banner({ doc }: { doc: import("../editor/document").Doc }) {
  if (doc.conflict !== null) {
    return (
      <div className="banner conflict">
        <span>{doc.path} changed on disk while this buffer has unsaved changes.</span>
        <button onClick={() => doc.keepMine()}>Keep mine</button>
        <button onClick={() => doc.takeTheirs()}>Take theirs</button>
        <button onClick={() => doc.openDiff()} disabled={doc.diffOpen}>Open both</button>
      </div>
    );
  }
  if (doc.diffOpen) {
    return (
      <div className="banner">
        <span>Showing the difference against the version on disk.</span>
        <button onClick={() => { doc.closeDiff(); doc.keepMine(); }}>Done</button>
      </div>
    );
  }
  if (doc.restored) {
    return <div className="banner info"><span>Unsaved changes from the previous session were restored. Save to keep them, or undo to discard.</span></div>;
  }
  if (doc.detached) {
    return <div className="banner warn"><span>{doc.path} was deleted or moved on disk. Saving recreates it.</span></div>;
  }
  if (doc.reloadedAt && Date.now() - doc.reloadedAt < 4000) {
    return <div className="banner info"><span>Reloaded from disk.</span></div>;
  }
  return null;
}
