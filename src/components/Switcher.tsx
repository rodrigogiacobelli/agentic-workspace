import { open } from "@tauri-apps/plugin-dialog";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, events } from "../api";
import { MODES, modeOf, pick } from "../modes";
import { report } from "../notice";
import type { Session, WindowRole, Workspace } from "../types";
import { Icon } from "./icons";
import { RowMenu, type Row } from "./Menu";
import { PanelsMenu } from "./PanelsMenu";
import { Prompt } from "./Prompt";

export { report };

/** A workspace row being dragged in the switcher; the data is its id. */
const WS_MIME = "application/x-agentic-workspace";

interface Props {
  session: Session;
  role: WindowRole;
  onSettings: () => void;
}

/**
 * The one row both windows carry in place of the compositor's title bar: the
 * logo and the workspace selector on the left, the mode selector centred on
 * the window, and the View menu, settings and the window controls on the
 * right. Empty parts of it drag the window and double-click maximises it.
 */
export function Switcher({ session, role, onSettings }: Props) {
  const active = session.workspaces.find((w) => w.id === session.active);
  /** The one text prompt this row opens, whatever asked for it. */
  const [prompt, setPrompt] = useState<{ title: string; initial: string; submit: (name: string) => void } | null>(null);
  const [maximized, setMaximized] = useState(false);

  // The window's own border and resize band exist only while it is not
  // maximised; the root carries the state for the stylesheet.
  useEffect(() => {
    const check = () => api.windowMaximized().then(setMaximized).catch(() => {});
    void check();
    const unlisten = events.onWindowResized(() => void check());
    return () => { void unlisten.then((u) => u()); };
  }, []);
  useEffect(() => { document.documentElement.dataset.maximized = maximized ? "true" : "false"; }, [maximized]);

  const addFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Add a workspace folder" });
    if (typeof picked === "string") await api.addWorkspace(picked).catch(report);
  };

  const remove = async (w: Workspace) => {
    const parts = [];
    // Buffers live in the Workspace window alone: the Terminal window has
    // none to count, and importing the editors there would fetch CodeMirror.
    const unsaved = role === "workspace" && w.id === session.active ? (await import("../editors")).dirtyCount() : 0;
    if (w.terminals.length) parts.push(`${w.terminals.length} terminal tab${w.terminals.length === 1 ? "" : "s"} will be closed and their processes terminated`);
    if (unsaved) parts.push(`${unsaved} unsaved editor buffer${unsaved === 1 ? "" : "s"} will be lost`);
    const detail = parts.length ? `\n\n${parts.join(".\n")}.` : "";
    const yes = await ask(`Remove workspace "${w.name}"?${detail}\n\nNo file on disk is deleted.`, {
      title: "Remove workspace",
      kind: "warning",
      okLabel: "Remove",
      cancelLabel: "Keep",
    });
    if (yes) await api.removeWorkspace(w.id).catch(report);
  };

  const label = active ? `${active.name}${active.available ? "" : " (unavailable)"}` : "No workspace";

  const row = (w: Workspace, children?: Row[]): Row => ({
    id: w.id,
    name: `${w.attention && w.id !== session.active ? "● " : ""}${w.name}${w.available ? "" : " (unavailable)"}`,
    detail: w.path,
    selected: w.id === session.active,
    onPick: () => { if (w.id !== session.active) void api.switchWorkspace(w.id).catch(report); },
    onRename: () => setPrompt({
      title: "Workspace name",
      initial: w.name,
      submit: (name) => void api.renameWorkspace(w.id, name).catch(report),
    }),
    onRemove: () => void remove(w),
    children,
  });

  /**
   * One row per workspace, a repository's disclosing its worktrees: first the
   * open ones, in the session's order — the backend's `worktreeOf` says
   * which are its, and the tray groups by the same field — then the others git
   * lists beside it. That list is git's own and is refreshed with the branch,
   * so a worktree added or removed outside the application appears and goes
   * without being added or removed here.
   *
   * Only a repository's own root lists unopened worktrees — git's
   * `is_worktree` says which one that is. Letting a linked worktree list them
   * too would have it offer its own repository as one of its worktrees.
   */
  const workspaceOn = (path: string) => session.workspaces.find((w) => w.path === path);
  const isMainWorktree = (w: Workspace) => w.git?.isRepo === true && !w.git.isWorktree;
  const tops = session.workspaces.filter((w) => !w.worktreeOf);
  const worktreesOf = (id: string) => session.workspaces.filter((w) => w.worktreeOf === id);
  const rows: Row[] = tops.map((w) => row(w, [
    ...worktreesOf(w.id).map((c): Row => ({
      // Naming labels the workspace, which is this row's to do. Removing is
      // not: under its repository a worktree is git's, and Source Control's
      // Worktrees panel is where it is deleted — with the warning about
      // running processes that BR-10 wants.
      ...row(c),
      onRemove: undefined,
      id: `${w.id}:${c.path}`,
      name: `⑂ ${c.name}${c.git?.branch && !c.git.detached ? ` · ${c.git.branch}` : ""}${c.available ? "" : " (unavailable)"}`,
    })),
    ...(isMainWorktree(w) ? w.git?.worktrees ?? [] : [])
      .filter((t) => !workspaceOn(t.path))
      .map((t): Row => ({
        id: `${w.id}:${t.path}`,
        name: `⑂ ${t.name}${t.branch ? ` · ${t.branch}` : ""}`,
        detail: t.path,
        onPick: () => void api.addWorkspace(t.path, undefined, true).catch(report),
        // A worktree nothing is open on has no name of its own yet — the row
        // shows git's. Naming it is what opens it, so the row offers the same
        // control as one already open: the row itself opens it under the
        // directory's name, this under a chosen one (BR-08).
        renameLabel: "Open as workspace…",
        onRename: () => setPrompt({
          title: "Open this worktree as…",
          initial: t.name,
          submit: (name) => void api.addWorkspace(t.path, name, true).catch(report),
        }),
      })),
  ]));

  /**
   * Puts a top-level row before another, or last (WS-11). The whole order
   * goes to the backend, each workspace followed by its open worktrees: an id
   * left out would be moved to the end, and the tray lists the same order.
   */
  const move = (id: string, before: string | null) => {
    const order = tops.map((w) => w.id).filter((t) => t !== id);
    const at = before === null ? order.length : order.indexOf(before);
    if (at < 0 || !tops.some((w) => w.id === id)) return;
    order.splice(at, 0, id);
    void api.reorderWorkspaces(order.flatMap((t) => [t, ...worktreesOf(t).map((c) => c.id)])).catch(report);
  };

  return (
    <>
      <header
        className="switcher"
        data-tauri-drag-region="deep"
        onContextMenu={(e) => {
          // KWin's own menu — move to desktop, keep above — as on any title bar (CHR-07).
          if ((e.target as HTMLElement).closest("button, input")) return;
          e.preventDefault();
          void api.showWindowMenu(e.clientX, e.clientY).catch(() => {});
        }}
      >
        <div className="switcher-left">
          <span className="switcher-logo" title="Agentic Workspace"><Icon name="logo" /></span>
          <RowMenu
            className="switcher-select"
            label={label}
            title={active?.path}
            minWidth={340}
            rows={rows}
            reorder={{ mime: WS_MIME, onMove: move }}
            footer={{ label: "＋ Add folder…", onClick: () => void addFolder() }}
            empty="No workspaces yet"
          />
          {session.workspaces.some((w) => w.attention && w.id !== session.active) && (
            <span className="attention-badge" title="A background workspace has new terminal output">●</span>
          )}
          {active?.available === false && <span className="switcher-path" title={active.path}>Missing: {active.path}</span>}
        </div>
        <ModeSelector ws={active} role={role} />
        <div className="switcher-right">
          {role === "workspace" && active && <PanelsMenu mode={active.mode} />}
          <button onClick={onSettings} title="Settings (Ctrl+,)">⚙</button>
          <span className="win-controls">
            <button onClick={() => void api.windowMinimize()} title="Minimise">−</button>
            <button onClick={() => void api.windowToggleMaximize()} title={maximized ? "Restore" : "Maximise"}>{maximized ? "❐" : "□"}</button>
            <button className="close" onClick={() => void api.windowClose()} title="Close (the app stays in the tray)">✕</button>
          </span>
        </div>
      </header>
      {!maximized && <ResizeEdges />}
      {prompt && (
        <Prompt
          title={prompt.title}
          initial={prompt.initial}
          onClose={() => setPrompt(null)}
          onSubmit={(name) => { const answered = prompt; setPrompt(null); answered.submit(name); }}
        />
      )}
    </>
  );
}

/**
 * Editor, Source Control and Terminal, one width each whatever they read.
 * It sits at the middle of the window rather than of the space left over, so
 * a long workspace name cannot push it off centre. Terminal is drawn in its
 * own window: picking it raises that window, and the dot on it says a shell
 * is running there — lit when one printed while out of view.
 */
function ModeSelector({ ws, role }: { ws: Workspace | undefined; role: WindowRole }) {
  const current = modeOf(ws, role);
  const shells = ws?.terminals.length ?? 0;
  const waiting = ws?.terminals.some((t) => t.attention) ?? false;
  return (
    <div className="mode-select" role="tablist" aria-label="Mode">
      {MODES.map((m) => (
        <button
          key={m.id}
          role="tab"
          aria-selected={m.id === current}
          className={m.id === current ? "on" : ""}
          onClick={() => void pick(ws, m.id, role).catch(report)}
          title={`${m.label} (${m.hotkey})`}
        >
          <span className="tab-glyph"><Icon name={m.icon} size={14} /></span>
          <span className="tab-word">{m.label}</span>
          {m.id === "terminal" && shells > 0 && (
            <span className={`mode-dot${waiting ? " waiting" : ""}`} title={`${shells} shell${shells === 1 ? "" : "s"} running${waiting ? ", one with new output" : ""}`} />
          )}
        </button>
      ))}
    </div>
  );
}

const EDGES = [
  ["n", "North"], ["s", "South"], ["e", "East"], ["w", "West"],
  ["ne", "NorthEast"], ["nw", "NorthWest"], ["se", "SouthEast"], ["sw", "SouthWest"],
] as const;

/**
 * The resize band of an undecorated window. The webview takes every pointer
 * event before the GTK window sees it, so the band is drawn here and the drag
 * is handed to the compositor (CHR-05).
 */
function ResizeEdges() {
  return (
    <>
      {EDGES.map(([cls, direction]) => (
        <div
          key={cls}
          className={`resize-edge resize-${cls}`}
          data-tauri-drag-region="false"
          onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); void api.windowStartResize(direction).catch(report); }}
        />
      ))}
    </>
  );
}
