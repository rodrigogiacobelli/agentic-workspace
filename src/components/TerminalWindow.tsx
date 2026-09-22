import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { actionFor } from "../hotkeys";
import * as terminals from "../terminals";
import type { Session, TerminalTab, Workspace } from "../types";
import { report } from "./Switcher";

interface Props {
  session: Session;
  openSwitcher: () => void;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

function labelOf(tab: TerminalTab): string {
  return tab.name ?? terminals.get(tab.id)?.title ?? basename(tab.cwd);
}

export function TerminalWindow({ session, openSwitcher }: Props) {
  const ws = session.workspaces.find((w) => w.id === session.active);
  const host = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const shownRef = useRef<string | null>(null);

  useEffect(() => terminals.onTitles(() => bump((n) => n + 1)), []);

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
        case "quit": void api.requestQuit(); break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ws, activeId, cycle, openSwitcher]);

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
    <div className="tabs">
      {ws.terminals.map((tab) => (
        <div
          key={tab.id}
          className={`tab${tab.id === ws.activeTerminal ? " active" : ""}`}
          draggable
          onDragStart={() => { dragging.current = tab.id; }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => drop(tab.id)}
          onClick={() => void api.setActiveTerminal(ws.id, tab.id)}
          onDoubleClick={() => onRename(tab.id)}
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
      <button className="tab-add" onClick={() => void api.terminalOpen(ws.id).catch(report)} title="New terminal (Ctrl+Shift+T)">＋</button>
    </div>
  );
}

function SearchBar({ id, onClose }: { id: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const search = terminals.get(id)?.search;
  const find = (next: boolean) => {
    if (!search || !query) return;
    if (next) search.findNext(query, { incremental: false });
    else search.findPrevious(query);
  };
  useEffect(() => { search?.findNext(query, { incremental: true }); }, [query, search]);
  return (
    <div className="searchbar">
      <input
        autoFocus
        placeholder="Search scrollback"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(!e.shiftKey);
          if (e.key === "Escape") { search?.clearDecorations(); onClose(); }
        }}
      />
      <button onClick={() => find(false)}>▲</button>
      <button onClick={() => find(true)}>▼</button>
      <button onClick={() => { search?.clearDecorations(); onClose(); }}>×</button>
    </div>
  );
}
