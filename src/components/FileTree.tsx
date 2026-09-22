import { useCallback, useEffect, useRef, useState } from "react";
import { api, events } from "../api";
import type { Entry, Workspace } from "../types";
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
  path: string;
}

/** The tree rooted at the workspace, read one directory at a time. */
export function FileTree({ ws, onOpen, selected, onSelect }: Props) {
  const [listings, setListings] = useState<Map<string, Entry[]>>(new Map());
  const [menu, setMenu] = useState<Menu | null>(null);
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
    });
    return () => { void unlisten.then((u) => u()); };
  }, [ws.id, listings, load]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", close); };
  }, [menu]);

  const toggle = (path: string) => {
    const expanded = ws.expanded.includes(path);
    void api.setExpanded(ws.id, path, !expanded);
  };

  const render = (dir: string, depth: number): React.ReactNode => {
    const entries = listings.get(dir);
    if (!entries) return depth === 0 ? <div className="tree-loading">Loading…</div> : null;
    return entries.map((e) => {
      const expanded = e.isDir && ws.expanded.includes(e.path);
      return (
        <div key={e.path}>
          <div
            className={`tree-row${e.ignored ? " ignored" : ""}${selected === e.path ? " selected" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => { onSelect(e.path); if (e.isDir) toggle(e.path); else onOpen(e.path); }}
            onContextMenu={(ev) => { ev.preventDefault(); onSelect(e.path); setMenu({ x: ev.clientX, y: ev.clientY, path: e.path }); }}
            title={e.path}
          >
            <span className="tree-chevron">{e.isDir ? (expanded ? "▾" : "▸") : ""}</span>
            <span className="tree-name">{e.name}</span>
          </div>
          {expanded && render(e.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <nav className="tree" onMouseDown={(e) => { if (e.target === e.currentTarget) onSelect(null); }}>
      {render("", 0)}
      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => { void api.copyText(menu.path); setMenu(null); }}>Copy relative path</button>
          <button onClick={() => { void api.copyText(`${ws.path}/${menu.path}`); setMenu(null); }}>Copy absolute path</button>
        </div>
      )}
    </nav>
  );
}
