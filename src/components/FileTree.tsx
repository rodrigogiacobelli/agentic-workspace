import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, events } from "../api";
import type { Entry, StatusEntry, View, Workspace } from "../types";
import { ContextMenu, Dropdown } from "./Menu";
import { Prompt } from "./Prompt";
import { FILE_MIME } from "./SplitTree";
import { report } from "./Switcher";

interface Props {
  ws: Workspace;
  /** A single click opens a preview tab; a double click or a new file opens a permanent one. */
  onOpen: (path: string, preview: boolean) => void;
  /** Inserts a citation of each path into the active document, one per line. */
  onQuote: (paths: string[]) => void;
  selected: string | null;
  onSelect: (path: string | null) => void;
  gitStatus?: StatusEntry[];
}

/** One letter per path, and a summary letter for every ancestor directory. */
function statusMap(status: StatusEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of status) {
    const letter = s.conflicted ? "!" : s.untracked ? "U" : s.index !== "." ? s.index : s.worktree;
    map.set(s.path, letter);
    const parts = s.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const prev = map.get(dir);
      if (prev === "!" ) continue;
      map.set(dir, letter === "!" ? "!" : prev === "U" || letter === "U" ? "U" : "M");
    }
  }
  return map;
}

interface Menu {
  x: number;
  y: number;
  entry: Entry | null;
  /** The row is one of the open view's own entries. */
  viewRoot: boolean;
}

type Dialog =
  | { kind: "new-file"; dir: string }
  | { kind: "new-folder"; dir: string }
  | { kind: "rename"; entry: Entry }
  | { kind: "new-view"; then?: string }
  | { kind: "rename-view"; view: View };

const NEW_VIEW = "__new-view";
const ENTRY_MIME = "application/x-agentic-view-entry";

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * The tree rooted at the workspace, read one directory at a time — or a
 * custom view: its entries at the root whatever their depth, each expanding
 * to its real children (VIEW-03, VIEW-04).
 */
export function FileTree({ ws, onOpen, onQuote, selected, onSelect, gitStatus = [] }: Props) {
  const gitMap = useMemo(() => statusMap(gitStatus), [gitStatus]);
  const [listings, setListings] = useState<Map<string, Entry[]>>(new Map());
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [filter, setFilter] = useState("");
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [viewEntries, setViewEntries] = useState<Entry[] | null>(null);
  /** Ctrl+click adds rows to a selection that Quote to AI cites together (CITE-13). */
  const [multi, setMulti] = useState<Set<string>>(new Set());
  /** Every row drawn in this render, in tree order. */
  const order = useRef<string[]>([]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const inflight = useRef(new Set<string>());
  const view = ws.views.find((v) => v.id === ws.activeView) ?? null;
  const entriesKey = view?.entries.join("\n") ?? "";

  const load = useCallback((dir: string) => {
    if (inflight.current.has(dir)) return;
    inflight.current.add(dir);
    api.listDir(ws.id, dir)
      .then((entries) => setListings((m) => new Map(m).set(dir, entries)))
      .catch(report)
      .finally(() => inflight.current.delete(dir));
  }, [ws.id]);

  const loadView = useCallback(() => {
    if (!view) { setViewEntries(null); return; }
    api.statEntries(ws.id, view.entries).then(setViewEntries).catch(report);
  }, [ws.id, view?.id, entriesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load("");
    ws.expanded.forEach((dir) => { if (!listings.has(dir)) load(dir); });
    // Listings are keyed by directory; a change of expansion only adds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.expanded, load]);

  useEffect(() => { loadView(); }, [loadView]);

  useEffect(() => {
    const unlisten = events.onDirChanged((change) => {
      if (change.workspaceId !== ws.id) return;
      change.dirs.forEach((dir) => { if (dir === "" || listings.has(dir)) load(dir); });
      if (filter) setAllFiles(null);
      loadView();
    });
    return () => { void unlisten.then((u) => u()); };
  }, [ws.id, listings, load, filter, loadView]);

  // The filter needs every path; it is fetched once per filter session.
  useEffect(() => {
    if (filter && allFiles === null) api.listFiles(ws.id).then(setAllFiles).catch(report);
  }, [filter, allFiles, ws.id]);

  const toggle = (path: string) => {
    void api.setExpanded(ws.id, path, !ws.expanded.includes(path));
  };

  const contextTarget = (): Entry | null => menu?.entry ?? null;
  const targetDir = (): string => {
    const e = contextTarget();
    return e ? (e.isDir ? e.path : dirOf(e.path)) : "";
  };

  const trash = async (entry: Entry) => {
    const yes = await ask(`Move ${entry.path} to the trash?`, { title: "Delete", kind: "warning", okLabel: "Move to trash", cancelLabel: "Keep" });
    if (yes) await api.trashEntry(ws.id, entry.path).catch(report);
  };

  const deleteView = async (v: View) => {
    const yes = await ask(`Delete the view "${v.name}"? Only the list goes; every file it points at stays.`, { title: "Delete view", kind: "warning", okLabel: "Delete view", cancelLabel: "Keep" });
    if (yes) await api.viewDelete(ws.id, v.id).catch(report);
  };

  const submitDialog = async (value: string) => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    try {
      if (d.kind === "new-file" || d.kind === "new-folder") {
        const path = join(d.dir, value);
        await api.createEntry(ws.id, path, d.kind === "new-folder");
        if (d.dir && !ws.expanded.includes(d.dir)) await api.setExpanded(ws.id, d.dir, true);
        if (d.kind === "new-file") onOpen(path, false);
      } else if (d.kind === "rename") {
        await api.renameEntry(ws.id, d.entry.path, join(dirOf(d.entry.path), value));
      } else if (d.kind === "new-view") {
        const id = await api.viewCreate(ws.id, value);
        if (d.then) await api.viewAdd(ws.id, id, d.then);
      } else if (d.kind === "rename-view") {
        await api.viewRename(ws.id, d.view.id, value);
      }
    } catch (e) {
      report(e);
    }
  };

  // A view's root rows are reordered by dragging one above another (VIEW-12).
  const reorderTo = (dragged: string, target: string) => {
    if (!view || dragged === target) return;
    const paths = view.entries.filter((p) => p !== dragged);
    const at = paths.indexOf(target);
    paths.splice(at < 0 ? paths.length : at, 0, dragged);
    void api.viewReorder(ws.id, view.id, paths).catch(report);
  };

  const row = (e: Entry, depth: number, expanded: boolean, onClick: () => void, viewRoot = false) => (
    order.current.push(e.path),
    <div
      className={`tree-row${e.ignored ? " ignored" : ""}${e.missing ? " missing" : ""}${selected === e.path || multi.has(e.path) ? " selected" : ""}${dragOver === e.path ? " drop-before" : ""}${gitMap.has(e.path) ? ` git-${gitMap.get(e.path)}` : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={(ev) => {
        if (ev.ctrlKey) {
          setMulti((m) => { const next = new Set(m); if (next.has(e.path)) next.delete(e.path); else next.add(e.path); if (selected && !next.has(selected)) next.add(selected); return next; });
          onSelect(e.path);
          return;
        }
        setMulti(new Set());
        onClick();
      }}
      onDoubleClick={() => { if (!e.isDir && !e.missing) onOpen(e.path, false); }}
      draggable={viewRoot || (!e.isDir && !e.missing)}
      onDragStart={(ev) => {
        if (!e.isDir && !e.missing) ev.dataTransfer.setData(FILE_MIME, e.path);
        if (viewRoot) ev.dataTransfer.setData(ENTRY_MIME, e.path);
        ev.dataTransfer.effectAllowed = "copyMove";
      }}
      onDragOver={(ev) => { if (viewRoot && ev.dataTransfer.types.includes(ENTRY_MIME)) { ev.preventDefault(); ev.stopPropagation(); setDragOver(e.path); } }}
      onDragLeave={() => { if (dragOver === e.path) setDragOver(null); }}
      onDrop={(ev) => { const dragged = ev.dataTransfer.getData(ENTRY_MIME); setDragOver(null); if (viewRoot && dragged) { ev.preventDefault(); ev.stopPropagation(); reorderTo(dragged, e.path); } }}
      onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); if (!multi.has(e.path)) { setMulti(new Set()); onSelect(e.path); } setMenu({ x: ev.clientX, y: ev.clientY, entry: e, viewRoot }); }}
      title={e.missing ? `Missing: ${e.path}` : e.path}
    >
      <span className="tree-chevron">{e.isDir ? (expanded ? "▾" : "▸") : ""}</span>
      <span className="tree-name">{e.missing ? e.path : e.name}</span>
      {gitMap.has(e.path) && <span className="tree-git">{e.isDir ? "•" : gitMap.get(e.path)}</span>}
    </div>
  );

  const render = (dir: string, depth: number): React.ReactNode => {
    const entries = listings.get(dir);
    if (!entries) return depth === 0 ? <div className="tree-loading">Loading…</div> : null;
    return entries.map((e) => {
      const expanded = e.isDir && ws.expanded.includes(e.path);
      return (
        <div key={e.path}>
          {row(e, depth, expanded, () => { onSelect(e.path); if (e.isDir) toggle(e.path); else onOpen(e.path, true); })}
          {expanded && render(e.path, depth + 1)}
        </div>
      );
    });
  };

  // A view's root: its entries in order, each expanding to real children.
  const renderView = (): React.ReactNode => {
    if (!viewEntries) return <div className="tree-loading">Loading…</div>;
    if (viewEntries.length === 0) return <div className="tree-loading">Nothing has been sent to this view yet. Right-click a file or folder in Files and choose “Send to {view?.name}”.</div>;
    return viewEntries.map((e) => {
      const expanded = e.isDir && ws.expanded.includes(e.path);
      const open = () => { onSelect(e.path); if (e.missing) return; if (e.isDir) toggle(e.path); else onOpen(e.path, true); };
      return (
        <div key={e.path}>
          {row(e, 0, expanded, open, true)}
          {expanded && (listings.has(e.path) ? render(e.path, 1) : (load(e.path), null))}
        </div>
      );
    });
  };

  // Filtered view: matching files and their ancestors, every directory open.
  const filtered = useMemo(() => {
    if (!filter || !allFiles) return null;
    const needle = filter.toLowerCase();
    const roots = view?.entries ?? null;
    const matches = allFiles
      .filter((p) => p.toLowerCase().includes(needle))
      .filter((p) => !roots || roots.some((r) => p === r || p.startsWith(`${r}/`)))
      .slice(0, 2000);
    const children = new Map<string, Map<string, boolean>>();
    for (const file of matches) {
      const parts = file.split("/");
      let dir = "";
      parts.forEach((part, i) => {
        const isLast = i === parts.length - 1;
        if (!children.has(dir)) children.set(dir, new Map());
        children.get(dir)!.set(part, !isLast);
        dir = join(dir, part);
      });
    }
    return children;
  }, [filter, allFiles, view?.entries]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderFiltered = (dir: string, depth: number): React.ReactNode => {
    const kids = filtered?.get(dir);
    if (!kids) return null;
    return [...kids.entries()]
      .sort(([a, ad], [b, bd]) => Number(bd) - Number(ad) || a.localeCompare(b))
      .map(([name, isDir]) => {
        const e: Entry = { name, path: join(dir, name), isDir, ignored: false };
        return (
          <div key={e.path}>
            {row(e, depth, true, () => { onSelect(e.path); if (!e.isDir) onOpen(e.path, true); })}
            {isDir && renderFiltered(e.path, depth + 1)}
          </div>
        );
      });
  };

  // A filtered view keeps its entries at the root and filters beneath them.
  const renderFilteredView = (): React.ReactNode => {
    if (!filtered || !viewEntries) return <div className="tree-loading">Loading…</div>;
    return viewEntries
      .filter((e) => e.isDir ? filtered.has(e.path) : e.path.toLowerCase().includes(filter.toLowerCase()))
      .map((e) => (
        <div key={e.path}>
          {row(e, 0, true, () => { onSelect(e.path); if (!e.isDir && !e.missing) onOpen(e.path, true); }, true)}
          {e.isDir && renderFiltered(e.path, 1)}
        </div>
      ));
  };

  const viewOptions = [
    { id: "", label: "Files" },
    ...ws.views.map((v) => ({ id: v.id, label: v.name })),
    { id: NEW_VIEW, label: "New view…" },
  ];

  const sendTargets = (path: string) => ws.views.filter((v) => !v.entries.includes(path));
  const citation = (e: Entry) => (e.isDir ? `${e.path}/` : e.path);
  /** What Quote to AI cites: the multi-selection in tree order, or the one row. */
  const quoteTargets = (e: Entry): string[] => {
    if (multi.size > 1 && multi.has(e.path)) {
      const isDir = (p: string) => viewEntries?.find((x) => x.path === p)?.isDir || [...listings.values()].flat().some((x) => x.path === p && x.isDir);
      return order.current.filter((p) => multi.has(p)).map((p) => (isDir(p) ? `${p}/` : p));
    }
    return [citation(e)];
  };
  order.current = [];

  return (
    <div className="sidebar-body">
      <div className="tree-head">
        <Dropdown
          value={ws.activeView ?? ""}
          options={viewOptions}
          onChange={(id) => { if (id === NEW_VIEW) setDialog({ kind: "new-view" }); else void api.setActiveView(ws.id, id || null).catch(report); }}
          title={view ? `View: ${view.name}` : "The workspace's files"}
        />
      </div>
      <input
        className="tree-filter"
        placeholder="Filter files"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") setFilter(""); }}
      />
      <nav
        className="tree"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
        onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, entry: null, viewRoot: false }); }}
      >
        {view
          ? (filter ? renderFilteredView() : renderView())
          : (filter ? (filtered ? renderFiltered("", 0) : <div className="tree-loading">Loading…</div>) : render("", 0))}
      </nav>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {/* A view's root is a list of shortcuts, not a directory: nothing new is created there (VIEW-06). */}
          {(!view || menu.entry) && !menu.entry?.missing && (
            <>
              <button onClick={() => { setDialog({ kind: "new-file", dir: targetDir() }); setMenu(null); }}>New file…</button>
              <button onClick={() => { setDialog({ kind: "new-folder", dir: targetDir() }); setMenu(null); }}>New folder…</button>
            </>
          )}
          {view && !menu.entry && (
            <>
              <button onClick={() => { setDialog({ kind: "new-view" }); setMenu(null); }}>New view…</button>
              <button onClick={() => { setDialog({ kind: "rename-view", view }); setMenu(null); }}>Rename view…</button>
              <button onClick={() => { void deleteView(view); setMenu(null); }}>Delete view</button>
            </>
          )}
          {menu.entry && menu.viewRoot && view && (
            <>
              <hr />
              <button onClick={() => { void api.viewRemove(ws.id, view.id, menu.entry!.path).catch(report); setMenu(null); }}>Remove from view</button>
            </>
          )}
          {menu.entry && !menu.entry.missing && (
            <>
              <hr />
              <button onClick={() => { onQuote(quoteTargets(menu.entry!)); setMenu(null); }}>Quote to AI{multi.size > 1 && multi.has(menu.entry.path) ? ` (${multi.size} files)` : ""}</button>
              {sendTargets(menu.entry.path).map((v) => (
                <button key={v.id} onClick={() => { void api.viewAdd(ws.id, v.id, menu.entry!.path).catch(report); setMenu(null); }}>Send to {v.name} view</button>
              ))}
              <button onClick={() => { setDialog({ kind: "new-view", then: menu.entry!.path }); setMenu(null); }}>Send to a new view…</button>
              <hr />
              <button onClick={() => { setDialog({ kind: "rename", entry: menu.entry! }); setMenu(null); }}>Rename…</button>
              <button onClick={() => { void api.duplicateEntry(ws.id, menu.entry!.path).catch(report); setMenu(null); }}>Duplicate</button>
              <button onClick={() => { void trash(menu.entry!); setMenu(null); }}>Move to trash</button>
              <hr />
              <button onClick={() => { void api.copyText(menu.entry!.path); setMenu(null); }}>Copy relative path</button>
              <button onClick={() => { void api.copyText(`${ws.path}/${menu.entry!.path}`); setMenu(null); }}>Copy absolute path</button>
              <button onClick={() => { void api.revealEntry(ws.id, menu.entry!.path).catch(report); setMenu(null); }}>Reveal in file manager</button>
            </>
          )}
        </ContextMenu>
      )}
      {dialog && (
        <Prompt
          title={
            dialog.kind === "new-file" ? "New file name"
              : dialog.kind === "new-folder" ? "New folder name"
              : dialog.kind === "new-view" ? "Name for the new view"
              : dialog.kind === "rename-view" ? "New name for the view"
              : "New name"
          }
          initial={dialog.kind === "rename" ? dialog.entry.name : dialog.kind === "rename-view" ? dialog.view.name : ""}
          selectEnd={dialog.kind === "rename" && !dialog.entry.isDir && dialog.entry.name.lastIndexOf(".") > 0 ? dialog.entry.name.lastIndexOf(".") : undefined}
          onSubmit={(v) => void submitDialog(v)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
