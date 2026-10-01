import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { actionFor } from "../hotkeys";
import { modalOpen } from "../modal";
import { familyOf, familyRoot, memberHolding, pick } from "../modes";
import { useDismiss } from "../motion";
import { report } from "../notice";
import * as terminals from "../terminals";
import type { Session, TerminalTab, Workspace } from "../types";
import { ContextMenu } from "./Menu";
import { dragTab, settleTabDrag, TabOverflow, useTabStrip } from "./tabs";

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

/** `path` from the folder `root`: `.`, `./sub`, or itself when outside. */
function relative(root: string, path: string): string {
  const r = root.replace(/\/+$/, "");
  return path === r ? "." : path.startsWith(`${r}/`) ? `./${path.slice(r.length + 1)}` : path;
}

/** Where in the family a shell is, said after its tab's label: nothing in
 *  the root's folder, a child's name in its folder, `⑂ name` in a worktree's
 *  (TERM-19). The deepest member holding the directory says. */
function placeOf(family: Workspace[], cwd: string): { member: Workspace | undefined; mark: string } {
  const member = memberHolding(family, cwd);
  const mark = !member ? "" : member.worktreeOf ? `⑂ ${member.name}` : member.childOf ? member.name : "";
  return { member, mark };
}

export function TerminalWindow({ session, openSwitcher, openSettings }: Props) {
  const ws = session.workspaces.find((w) => w.id === session.active);
  // Every member of a family shows its root's list: one list, one tab in
  // front, whichever member is on screen (TERM-16).
  const home = familyRoot(session.workspaces, ws);
  const host = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const shownRef = useRef<string | null>(null);

  // The tab strip names the shown family's shells; a title from a terminal
  // of another family changes nothing here.
  useEffect(() => terminals.onTitles((id) => {
    if (home?.terminals.some((t) => t.id === id)) bump((n) => n + 1);
  }), [home]);

  // A path printed in a terminal is resolved against that terminal's working
  // directory, then opened in the Workspace window at its line, in the member
  // of the terminal's family holding it: the one on screen when it does, else
  // the deepest (TERM-24).
  useEffect(() => {
    terminals.setLinkHandler((terminalId, target) => {
      const owner = session.workspaces.find((w) => w.terminals.some((t) => t.id === terminalId));
      const tab = owner?.terminals.find((t) => t.id === terminalId);
      if (!owner || !tab) return;
      let abs = target.path;
      if (abs.startsWith("~/")) abs = `${owner.path.replace(/\/+$/, "")}/${abs.slice(2)}`;
      else if (!abs.startsWith("/")) abs = `${tab.cwd.replace(/\/+$/, "")}/${abs}`;
      const parts: string[] = [];
      for (const p of abs.split("/")) { if (p === "..") parts.pop(); else if (p && p !== ".") parts.push(p); }
      abs = `/${parts.join("/")}`;
      const member = memberHolding(familyOf(session.workspaces, owner), abs, session.active);
      if (!member) { report(`${abs} is in no workspace of ${owner.name}'s family`); return; }
      const root = member.path.replace(/\/+$/, "");
      const rel = abs === root ? "" : abs.slice(root.length + 1);
      void api.openAt({ workspaceId: member.id, path: rel, line: target.line, column: target.column });
      void api.focusWindow("workspace");
    });
  }, [session]);

  // Instances belong to tabs; a tab that vanished takes its instance with it.
  useEffect(() => {
    terminals.retain(new Set(session.workspaces.flatMap((w) => w.terminals.map((t) => t.id))));
  }, [session]);

  const activeId = home?.activeTerminal ?? null;
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
    if (!ws || !home || home.terminals.length === 0) return;
    const i = home.terminals.findIndex((t) => t.id === home.activeTerminal);
    const next = home.terminals[(i + delta + home.terminals.length) % home.terminals.length];
    void api.setActiveTerminal(ws.id, next.id);
  }, [ws, home]);

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

  if (!ws || !home) {
    return <main className="empty">Add a folder to start.</main>;
  }

  return (
    <main className="terminal-main">
      <TabStrip
        ws={ws}
        home={home}
        family={familyOf(session.workspaces, home)}
        renaming={renaming}
        onRename={(id) => setRenaming(id)}
        onRenamed={() => setRenaming(null)}
      />
      <div className="terminal-host" ref={host}>
        {home.terminals.length === 0 && (
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
 * it runs, where, and how many others there are — of the family on screen,
 * whose root holds them. The directory reads from the member holding it,
 * marked as its tab is (TERM-19).
 */
export function TerminalFacts({ ws, session }: { ws: Workspace; session: Session }) {
  const [, bump] = useState(0);
  const home = familyRoot(session.workspaces, ws) ?? ws;
  const shown = home.activeTerminal;
  useEffect(() => terminals.onTitles((id) => { if (id === shown) bump((n) => n + 1); }), [shown]);
  const tab = home.terminals.find((t) => t.id === shown);
  const place = tab && placeOf(familyOf(session.workspaces, home), tab.cwd);
  const cwd = tab && place ? `${place.mark ? `${place.mark} ` : ""}${relative(place.member?.path ?? home.path, tab.cwd)}` : null;
  const waiting = home.terminals.filter((t) => t.attention).length;
  return (
    <>
      {tab && <span className="statusbar-mono">{terminals.get(tab.id)?.title || tab.name || "shell"}</span>}
      {cwd && <span className="statusbar-mono" title={tab?.cwd}>{cwd}</span>}
      <span>
        {home.terminals.length} tab{home.terminals.length === 1 ? "" : "s"}
        {waiting > 0 && ` · ${waiting} with output`}
      </span>
    </>
  );
}

/** The family's tabs. Every call names `ws`, the member on screen: the
 *  backend finds the family's list from it, and ＋ opens where it says. */
function TabStrip({ ws, home, family, renaming, onRename, onRenamed }: {
  ws: Workspace;
  home: Workspace;
  family: Workspace[];
  renaming: string | null;
  onRename: (id: string) => void;
  onRenamed: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const strip = useTabStrip(home.activeTerminal, home.terminals.length);
  const marks = new Map(home.terminals.map((t) => [t.id, placeOf(family, t.cwd).mark]));

  // A tab dragged along the strip lands in the slot under the pointer; off
  // the strip there is nowhere to land, and a release puts it back (TAB-15).
  const drag = (e: React.PointerEvent<HTMLElement>) => dragTab(e, {
    tabsOf: (el) => Array.from(el.querySelectorAll<HTMLElement>(":scope > [data-tab]")),
    hit: (x, y) => {
      const el = strip.ref.current;
      return el && el.parentElement?.contains(document.elementFromPoint(x, y)) ? { strip: el } : null;
    },
    drop: (to) => ("order" in to ? api.reorderTerminals(ws.id, to.order).catch(report) : Promise.resolve()),
  });
  // The strip's tabs changing is a dropped tab's move arriving.
  useLayoutEffect(settleTabDrag, [home.terminals.map((t) => t.id).join("\n")]);

  const restart = async (id: string) => {
    const tab = home.terminals.find((t) => t.id === id);
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
      <div className="tabs" ref={strip.ref} onWheel={strip.onWheel}>
      {home.terminals.map((tab) => (
        <div
          key={tab.id}
          data-tab={tab.id}
          className={`tab${tab.id === home.activeTerminal ? " active" : ""}${tab.attention ? " attention" : ""}`}
          onPointerDown={drag}
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
            <>
              <span className="tab-label">{labelOf(tab)}</span>
              {marks.get(tab.id) && <span className="tab-where">{marks.get(tab.id)}</span>}
            </>
          )}
          <button className="tab-close" onClick={(e) => { e.stopPropagation(); void api.terminalClose(tab.id); }} title="Close (Ctrl+Shift+W)">×</button>
        </div>
      ))}
      <span className="tabs-spacer" />
      </div>
      <TabOverflow
        strip={strip}
        entries={home.terminals.map((t) => ({ id: t.id, label: labelOf(t), active: t.id === home.activeTerminal }))}
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
