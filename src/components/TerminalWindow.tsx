import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { actionFor } from "../hotkeys";
import { useDismiss } from "../motion";
import * as terminals from "../terminals";
import type { Session, TerminalTab, Workspace } from "../types";
import { ContextMenu } from "./Menu";
import { report } from "./Switcher";
import { TabOverflow, useTabStrip } from "./tabs";

interface Props {
  session: Session;
  openSwitcher: () => void;
  openSettings: () => void;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

function labelOf(tab: TerminalTab): string {
  return tab.name ?? terminals.get(tab.id)?.title ?? basename(tab.cwd);
}

export function TerminalWindow({ session, openSwitcher, openSettings }: Props) {
  const ws = session.workspaces.find((w) => w.id === session.active);
  const host = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const shownRef = useRef<string | null>(null);

  useEffect(() => terminals.onTitles(() => bump((n) => n + 1)), []);

  // A path printed in a terminal is resolved against that terminal's working
  // directory, then opened in the Workspace window at its line.
  useEffect(() => {
    terminals.setLinkHandler((terminalId, target) => {
      const owner = session.workspaces.find((w) => w.terminals.some((t) => t.id === terminalId));
      const tab = owner?.terminals.find((t) => t.id === terminalId);
      if (!owner || !tab) return;
      const root = owner.path.replace(/\/+$/, "");
      let abs = target.path;
      if (abs.startsWith("~/")) abs = `${root}/${abs.slice(2)}`;
      else if (!abs.startsWith("/")) abs = `${tab.cwd.replace(/\/+$/, "")}/${abs}`;
      const parts: string[] = [];
      for (const p of abs.split("/")) { if (p === "..") parts.pop(); else if (p && p !== ".") parts.push(p); }
      abs = `/${parts.join("/")}`;
      if (abs !== root && !abs.startsWith(`${root}/`)) { report(`${abs} is outside the workspace ${owner.name}`); return; }
      const rel = abs === root ? "" : abs.slice(root.length + 1);
      void api.openAt({ workspaceId: owner.id, path: rel, line: target.line, column: target.column });
      void api.focusWindow("workspace");
    });
  }, [session]);

  // Instances belong to tabs; a tab that vanished takes its instance with it.
  useEffect(() => {
    terminals.retain(new Set(session.workspaces.flatMap((w) => w.terminals.map((t) => t.id))));
  }, [session]);

  const activeId = ws?.activeTerminal ?? null;
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    if (shownRef.current && shownRef.current !== activeId) terminals.unmount(shownRef.current);
    shownRef.current = activeId;
    if (activeId) void terminals.mount(activeId, container).catch(report);
  }, [activeId]);

  // The window resizing while a terminal is shown refits it; a hidden one is
  // refitted when it is next mounted.
  useEffect(() => {
    const onResize = () => { if (shownRef.current) terminals.get(shownRef.current)?.fit.fit(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const cycle = useCallback((delta: number) => {
    if (!ws || ws.terminals.length === 0) return;
    const i = ws.terminals.findIndex((t) => t.id === ws.activeTerminal);
    const next = ws.terminals[(i + delta + ws.terminals.length) % ws.terminals.length];
    void api.setActiveTerminal(ws.id, next.id);
  }, [ws]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = actionFor(e);
      if (!action) return;
      const inst = activeId ? terminals.get(activeId) : undefined;
      switch (action) {
        case "switch-workspace": openSwitcher(); break;
        case "focus-other-window": void api.focusWindow("workspace"); break;
        case "new-terminal": if (ws) void api.terminalOpen(ws.id).catch(report); break;
        case "close-terminal": if (activeId) void api.terminalClose(activeId); break;
        case "next-tab": cycle(1); break;
        case "prev-tab": cycle(-1); break;
        case "copy": {
          const text = inst?.term.getSelection();
          if (text) void api.copyText(text);
          break;
        }
        case "paste":
          void api.pasteText().then((t) => { if (t) inst?.term.paste(t); });
          break;
        case "search": setSearching(true); break;
        case "settings": openSettings(); break;
        case "quit": void api.requestQuit(); break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ws, activeId, cycle, openSwitcher, openSettings]);

  if (!ws) {
    return <main className="empty">Add a folder to start.</main>;
  }

  return (
    <main className="terminal-main">
      <TabStrip
        ws={ws}
        renaming={renaming}
        onRename={(id) => setRenaming(id)}
        onRenamed={() => setRenaming(null)}
      />
      <div className="terminal-host" ref={host}>
        {ws.terminals.length === 0 && (
          <div className="empty">No terminals. Press Ctrl+Shift+T to open one.</div>
        )}
      </div>
      {searching && activeId && (
        <SearchBar id={activeId} onClose={() => { setSearching(false); terminals.get(activeId)?.term.focus(); }} />
      )}
    </main>
  );
}

function TabStrip({ ws, renaming, onRename, onRenamed }: {
  ws: Workspace;
  renaming: string | null;
  onRename: (id: string) => void;
  onRenamed: () => void;
}) {
  const dragging = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const strip = useTabStrip(ws.activeTerminal, ws.terminals.length);

  const drop = (targetId: string) => {
    const from = dragging.current;
    dragging.current = null;
    if (!from || from === targetId) return;
    const ids = ws.terminals.map((t) => t.id);
    ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(targetId), 0, from);
    void api.reorderTerminals(ws.id, ids);
  };

  return (
    <div className="tab-bar">
      <div className="tabs" ref={strip.ref} onWheel={strip.onWheel}>
      {ws.terminals.map((tab) => (
        <div
          key={tab.id}
          data-tab={tab.id}
          className={`tab${tab.id === ws.activeTerminal ? " active" : ""}${tab.attention ? " attention" : ""}`}
          draggable
          onDragStart={() => { dragging.current = tab.id; }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => drop(tab.id)}
          onClick={() => void api.setActiveTerminal(ws.id, tab.id)}
          onDoubleClick={() => onRename(tab.id)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: tab.id }); }}
          title={tab.cwd}
        >
          {renaming === tab.id ? (
            <input
              autoFocus
              className="tab-rename"
              defaultValue={tab.name ?? ""}
              placeholder={labelOf(tab)}
              onBlur={(e) => { void api.terminalRename(tab.id, e.target.value || null); onRenamed(); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") onRenamed();
              }}
            />
          ) : (
            <span className="tab-label">{labelOf(tab)}</span>
          )}
          <button className="tab-close" onClick={(e) => { e.stopPropagation(); void api.terminalClose(tab.id); }} title="Close (Ctrl+Shift+W)">×</button>
        </div>
      ))}
      <span className="tabs-spacer" />
      </div>
      <TabOverflow
        strip={strip}
        entries={ws.terminals.map((t) => ({ id: t.id, label: labelOf(t), active: t.id === ws.activeTerminal }))}
        onPick={(id) => void api.setActiveTerminal(ws.id, id)}
      />
      <button className="tab-add" onClick={() => void api.terminalOpen(ws.id).catch(report)} title="New terminal (Ctrl+Shift+T)">＋</button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu} onClose={() => setMenu(null)}>
          <button onClick={() => { onRename(menu.id); setMenu(null); }}>Rename…</button>
          <button onClick={() => { void api.terminalRename(menu.id, null); setMenu(null); }}>Use the program's title</button>
          <hr />
          <button onClick={() => { void api.terminalClose(menu.id); setMenu(null); }}>Close</button>
        </ContextMenu>
      )}
    </div>
  );
}

function SearchBar({ id, onClose }: { id: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const search = terminals.get(id)?.search;
  const [closing, dismiss] = useDismiss(onClose);
  const close = () => { search?.clearDecorations(); dismiss(); };
  const find = (next: boolean) => {
    if (!search || !query) return;
    if (next) search.findNext(query, { incremental: false });
    else search.findPrevious(query);
  };
  useEffect(() => { search?.findNext(query, { incremental: true }); }, [query, search]);
  return (
    <div className={`searchbar${closing ? " is-closing" : ""}`}>
      <input
        autoFocus
        placeholder="Search scrollback"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(!e.shiftKey);
          if (e.key === "Escape") close();
        }}
      />
      <button onClick={() => find(false)}>▲</button>
      <button onClick={() => find(true)}>▼</button>
      <button onClick={close}>×</button>
    </div>
  );
}
