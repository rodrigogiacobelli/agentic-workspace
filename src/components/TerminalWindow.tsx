import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { actionFor } from "../hotkeys";
import { modalOpen } from "../modal";
import { pick } from "../modes";
import { useDismiss } from "../motion";
import { report } from "../notice";
import * as terminals from "../terminals";
import type { Session, TerminalTab, Workspace } from "../types";
import { ContextMenu } from "./Menu";
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
  return tab.name ?? (terminals.get(tab.id)?.title || basename(tab.cwd));
}

export function TerminalWindow({ session, openSwitcher, openSettings }: Props) {
  const ws = session.workspaces.find((w) => w.id === session.active);
  const host = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const shownRef = useRef<string | null>(null);

  // The tab strip names the shown workspace's shells; a title from a
  // terminal in another workspace changes nothing here.
  useEffect(() => terminals.onTitles((id) => {
    if (ws?.terminals.some((t) => t.id === id)) bump((n) => n + 1);
  }), [ws]);

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
      // Behind a modal the keyboard is the modal's. Ctrl+Shift+V here would
      // paste a passphrase meant for the dialog into the shell it covers.
      if (modalOpen() && action !== "quit") return;
      const inst = activeId ? terminals.get(activeId) : undefined;
      switch (action) {
        case "switch-workspace": openSwitcher(); break;
        case "focus-other-window": void api.focusWindow("workspace"); break;
        case "mode-editor": void pick(ws, "editor", "terminal").catch(report); break;
        case "mode-scm": void pick(ws, "scm", "terminal").catch(report); break;
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

/**
 * The status bar's facts for the Terminal window: the shell on screen, what
 * it runs, where, and how many others there are.
 */
export function TerminalFacts({ ws }: { ws: Workspace }) {
  const [, bump] = useState(0);
  const shown = ws.activeTerminal;
  useEffect(() => terminals.onTitles((id) => { if (id === shown) bump((n) => n + 1); }), [shown]);
  const tab = ws.terminals.find((t) => t.id === shown);
  const root = ws.path.replace(/\/+$/, "");
  const cwd = tab ? (tab.cwd === root ? "." : tab.cwd.startsWith(`${root}/`) ? `./${tab.cwd.slice(root.length + 1)}` : tab.cwd) : null;
  const waiting = ws.terminals.filter((t) => t.attention).length;
  return (
    <>
      {tab && <span className="statusbar-mono">{terminals.get(tab.id)?.title || tab.name || "shell"}</span>}
      {cwd && <span className="statusbar-mono" title={tab?.cwd}>{cwd}</span>}
      <span>
        {ws.terminals.length} tab{ws.terminals.length === 1 ? "" : "s"}
        {waiting > 0 && ` · ${waiting} with output`}
      </span>
    </>
  );
}

/** What a dragged terminal tab carries: its id. */
const TERMINAL_MIME = "application/x-agentic-terminal";

function TabStrip({ ws, renaming, onRename, onRenamed }: {
  ws: Workspace;
  renaming: string | null;
  onRename: (id: string) => void;
  onRenamed: () => void;
}) {
  // The tab being dragged. A drag's data cannot be read before the drop, and
  // the strip needs the tab earlier, to offer only the places it would move to.
  const dragging = useRef<string | null>(null);
  // Where the dragged tab would land: before the tab at this index, or after
  // the last one when it is the tab count.
  const [over, setOver] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const strip = useTabStrip(ws.activeTerminal, ws.terminals.length);

  // A tab dropped on another lands before it; dropped on the empty strip past
  // the last tab, it goes last.
  const placeOf = (e: React.DragEvent): number | null => {
    if (!(e.target instanceof Element)) return null;
    const id = e.target.closest<HTMLElement>("[data-tab]")?.dataset.tab;
    if (id) return ws.terminals.findIndex((t) => t.id === id);
    return e.target.closest(".tabs-spacer") ? ws.terminals.length : null;
  };

  // Dropped on itself, or just before the tab that already follows it, a tab
  // would stay where it is.
  const moves = (from: string | null, at: number) => {
    const i = ws.terminals.findIndex((t) => t.id === from);
    return i >= 0 && at >= 0 && at !== i && at !== i + 1;
  };

  // WebKit fires only `dragenter` on the move that reaches a new element, and
  // its answer decides whether a release there drops; `dragover` comes on the
  // move after. Both are asked, and anywhere refused GTK cancels the drop.
  const track = (e: React.DragEvent) => {
    const at = placeOf(e);
    const ok = at !== null && e.dataTransfer.types.includes(TERMINAL_MIME) && moves(dragging.current, at);
    if (ok) e.preventDefault();
    setOver(ok ? at : null);
  };

  // Crossing from a tab onto its label, or onto the next tab, fires
  // `dragleave` too, after the new element's `dragenter`, and WebKit names no
  // related target: only a pointer outside the strip has left it.
  const leave = (e: React.DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) setOver(null);
  };

  const drop = (e: React.DragEvent) => {
    const from = e.dataTransfer.getData(TERMINAL_MIME);
    const at = placeOf(e);
    setOver(null);
    if (at === null || !moves(from, at)) return;
    e.preventDefault();
    const ids = ws.terminals.map((t) => t.id);
    const i = ids.indexOf(from);
    ids.splice(i, 1);
    ids.splice(at > i ? at - 1 : at, 0, from);
    void api.reorderTerminals(ws.id, ids);
  };

  const restart = async (id: string) => {
    const tab = ws.terminals.find((t) => t.id === id);
    if (!tab) return;
    const yes = await ask(`Restart the shell in “${labelOf(tab)}”? Whatever runs in it now stops.`, {
      title: "Restart shell",
      kind: "warning",
      okLabel: "Restart",
      cancelLabel: "Keep",
    });
    if (yes) await api.terminalRestart(id).catch((e) => report(`The shell in “${labelOf(tab)}” was not restarted: ${String(e)}`));
  };

  return (
    <div className="tab-bar">
      <div
        className="tabs"
        ref={strip.ref}
        onWheel={strip.onWheel}
        onDragEnter={track}
        onDragOver={track}
        onDragLeave={leave}
        onDrop={drop}
      >
      {ws.terminals.map((tab, i) => (
        <div
          key={tab.id}
          data-tab={tab.id}
          className={`tab${tab.id === ws.activeTerminal ? " active" : ""}${tab.attention ? " attention" : ""}${over === i ? " drop-before" : ""}`}
          draggable
          // WebKitGTK starts no drag whose data transfer is empty.
          onDragStart={(e) => { dragging.current = tab.id; e.dataTransfer.setData(TERMINAL_MIME, tab.id); e.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { dragging.current = null; setOver(null); }}
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
      <span className={`tabs-spacer${over === ws.terminals.length ? " drop-before" : ""}`} />
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
          <button onClick={() => { void restart(menu.id); setMenu(null); }}>Restart shell</button>
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
