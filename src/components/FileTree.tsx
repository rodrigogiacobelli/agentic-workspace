import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, events } from "../api";
import type { Entry, Workspace } from "../types";
import { Prompt } from "./Prompt";
import { report } from "./Switcher";

interface Props {
  ws: Workspace;
  onOpen: (path: string) => void;
  selected: string | null;
  onSelect: (path: string | null) => void;
}

interface Menu {
  x: number;
  y: number;
  entry: Entry | null;
}

type Dialog =
  | { kind: "new-file"; dir: string }
  | { kind: "new-folder"; dir: string }
  | { kind: "rename"; entry: Entry };

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** The tree rooted at the workspace, read one directory at a time. */
export function FileTree({ ws, onOpen, selected, onSelect }: Props) {
  const [listings, setListings] = useState<Map<string, Entry[]>>(new Map());
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [filter, setFilter] = useState("");
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const inflight = useRef(new Set<string>());

  const load = useCallback((dir: string) => {
    if (inflight.current.has(dir)) return;
    inflight.current.add(dir);
    api.listDir(ws.id, dir)
      .then((entries) => setListings((m) => new Map(m).set(dir, entries)))
      .catch(report)
      .finally(() => inflight.current.delete(dir));
  }, [ws.id]);

  useEffect(() => {
    load("");
    ws.expanded.forEach((dir) => { if (!listings.has(dir)) load(dir); });
    // Listings are keyed by directory; a change of expansion only adds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.expanded, load]);

  useEffect(() => {
    const unlisten = events.onDirChanged((change) => {
      if (change.workspaceId !== ws.id) return;
      change.dirs.forEach((dir) => { if (dir === "" || listings.has(dir)) load(dir); });
      if (filter) setAllFiles(null);
    });
    return () => { void unlisten.then((u) => u()); };
  }, [ws.id, listings, load, filter]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", close); };
  }, [menu]);

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

  const submitDialog = async (value: string) => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    try {
      if (d.kind === "new-file" || d.kind === "new-folder") {
        const path = join(d.dir, value);
        await api.createEntry(ws.id, path, d.kind === "new-folder");
        if (d.dir && !ws.expanded.includes(d.dir)) await api.setExpanded(ws.id, d.dir, true);
        if (d.kind === "new-file") onOpen(path);
      } else if (d.kind === "rename") {
        await api.renameEntry(ws.id, d.entry.path, join(dirOf(d.entry.path), value));
      }
    } catch (e) {
      report(e);
    }
  };

  const row = (e: Entry, depth: number, expanded: boolean, onClick: () => void) => (
    <div
      className={`tree-row${e.ignored ? " ignored" : ""}${selected === e.path ? " selected" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={onClick}
      onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); onSelect(e.path); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }); }}
      title={e.path}
    >
      <span className="tree-chevron">{e.isDir ? (expanded ? "▾" : "▸") : ""}</span>
      <span className="tree-name">{e.name}</span>
    </div>
  );

  const render = (dir: string, depth: number): React.ReactNode => {
    const entries = listings.get(dir);
    if (!entries) return depth === 0 ? <div className="tree-loading">Loading…</div> : null;
    return entries.map((e) => {
      const expanded = e.isDir && ws.expanded.includes(e.path);
      return (
        <div key={e.path}>
          {row(e, depth, expanded, () => { onSelect(e.path); if (e.isDir) toggle(e.path); else onOpen(e.path); })}
          {expanded && render(e.path, depth + 1)}
        </div>
      );
    });
  };

  // Filtered view: matching files and their ancestors, every directory open.
  const filtered = useMemo(() => {
    if (!filter || !allFiles) return null;
    const needle = filter.toLowerCase();
    const matches = allFiles.filter((p) => p.toLowerCase().includes(needle)).slice(0, 2000);
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
  }, [filter, allFiles]);

  const renderFiltered = (dir: string, depth: number): React.ReactNode => {
    const kids = filtered?.get(dir);
    if (!kids) return null;
    return [...kids.entries()]
      .sort(([a, ad], [b, bd]) => Number(bd) - Number(ad) || a.localeCompare(b))
      .map(([name, isDir]) => {
        const e: Entry = { name, path: join(dir, name), isDir, ignored: false };
        return (
          <div key={e.path}>
            {row(e, depth, true, () => { onSelect(e.path); if (!e.isDir) onOpen(e.path); })}
            {isDir && renderFiltered(e.path, depth + 1)}
          </div>
        );
      });
  };

  return (
    <div className="sidebar-body">
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
        onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, entry: null }); }}
      >
        {filter ? (filtered ? renderFiltered("", 0) : <div className="tree-loading">Loading…</div>) : render("", 0)}
      </nav>
      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => { setDialog({ kind: "new-file", dir: targetDir() }); setMenu(null); }}>New file…</button>
          <button onClick={() => { setDialog({ kind: "new-folder", dir: targetDir() }); setMenu(null); }}>New folder…</button>
          {menu.entry && (
            <>
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
        </div>
      )}
      {dialog && (
        <Prompt
          title={dialog.kind === "new-file" ? "New file name" : dialog.kind === "new-folder" ? "New folder name" : "New name"}
          initial={dialog.kind === "rename" ? dialog.entry.name : ""}
          selectEnd={dialog.kind === "rename" && !dialog.entry.isDir && dialog.entry.name.lastIndexOf(".") > 0 ? dialog.entry.name.lastIndexOf(".") : undefined}
          onSubmit={(v) => void submitDialog(v)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
