import { open } from "@tauri-apps/plugin-dialog";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, events } from "../api";
import { familyOf, familyRoot, MODES, modeOf, pick } from "../modes";
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
  const workspaceOn = (path: string) => session.workspaces.find((w) => w.path === path);
  const isMainWorktree = (w: Workspace) => w.git?.isRepo === true && !w.git.isWorktree;
  const roots = session.workspaces.filter((w) => !w.worktreeOf && !w.childOf);
  const worktreesOf = (id: string) => session.workspaces.filter((w) => w.worktreeOf === id);
  const childrenOf = (id: string) => session.workspaces.filter((w) => w.childOf === id);
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

  /**
   * The files of `w`'s Editor tabs that hold unsaved text: a document with
   * changes open in this window, or, for a file no document here holds, the
   * draft a document left on disk. Documents live in the Workspace window
   * alone — importing the editors in the Terminal window would fetch
   * CodeMirror — so that window counts drafts, which trail typing by a
   * second and a half.
   */
  const unsavedIn = async (w: Workspace): Promise<number> => {
    const editors = role === "workspace" ? await import("../editors") : null;
    const tabs = w.groups.flatMap((g) => g.editors);
    const held = await Promise.all([...new Set(tabs.map((t) => t.path))].map(async (path) => {
      const open = tabs.filter((t) => t.path === path && editors?.get(t.id));
      if (open.length) return open.some((t) => editors?.isDirty(t.id));
      return (await api.readDraft(w.id, path).catch(() => null)) !== null;
    }));
    return held.filter(Boolean).length;
  };

  /**
   * Removes a workspace with what is listed under it — a root its family, a
   * child its worktrees — as the backend does (WS-21). The question names
   * each workspace going with it, the shells closed and each one's unsaved
   * text.
   */
  const remove = async (w: Workspace) => {
    const along = (familyRoot(session.workspaces, w)?.id === w.id ? familyOf(session.workspaces, w) : worktreesOf(w.id)).filter((m) => m.id !== w.id);
    const gone = [w, ...along];
    const shells = gone.reduce((n, m) => n + m.terminals.length, 0);
    const unsaved = await Promise.all(gone.map(async (m) => ({ name: m.name, count: await unsavedIn(m) })));
    const parts = [];
    if (along.length) parts.push(`These workspaces go with it: ${along.map((m) => `${m.worktreeOf ? "⑂ " : ""}${m.name}`).join(", ")}`);
    if (shells) parts.push(`${shells} terminal tab${shells === 1 ? "" : "s"} will be closed and their processes terminated`);
    for (const { name, count } of unsaved.filter((u) => u.count)) parts.push(`${name} holds ${count} unsaved editor buffer${count === 1 ? "" : "s"} that will be lost`);
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
  /** Only a family's root holds terminals, so only a root wants attention,
   *  and never while any member of its family is on screen (AGT-10, AGT-11). */
  const home = familyRoot(session.workspaces, active);
  const wants = (w: Workspace) => w.attention && w.id !== home?.id;

  const row = (w: Workspace, children?: Row[]): Row => ({
    id: w.id,
    name: `${wants(w) ? "● " : ""}${w.name}${w.available ? "" : " (unavailable)"}`,
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
   * A repository row's worktrees: first the open ones, in the session's order
   * — the backend's `worktreeOf` says which are its, and the tray groups by
   * the same field — then the others git lists beside it. That list is git's
   * own and is refreshed with the branch, so a worktree added or removed
   * outside the application appears and goes without being added or removed
   * here. Picking one opens it under this row (assumption 4).
   *
   * Only a repository's own root lists unopened worktrees — git's
   * `is_worktree` says which one that is. Letting a linked worktree list them
   * too would have it offer its own repository as one of its worktrees.
   */
  const worktreeRows = (p: Workspace): Row[] => [
    ...worktreesOf(p.id).map((c): Row => ({
      // Naming labels the workspace, which is this row's to do. Removing is
      // not: under its repository a worktree is git's, and Source Control's
      // Worktrees panel is where it is deleted — with the warning about
      // running processes that BR-10 wants.
      ...row(c),
      onRemove: undefined,
      id: `${p.id}:${c.path}`,
      name: `⑂ ${c.name}${c.git?.branch && !c.git.detached ? ` · ${c.git.branch}` : ""}${c.available ? "" : " (unavailable)"}`,
    })),
    ...(isMainWorktree(p) ? p.git?.worktrees ?? [] : [])
      .filter((t) => !workspaceOn(t.path))
      .map((t): Row => ({
        id: `${p.id}:${t.path}`,
        name: `⑂ ${t.name}${t.branch ? ` · ${t.branch}` : ""}`,
        detail: t.path,
        onPick: () => void api.addWorkspace(t.path, undefined, true, p.id).catch(report),
        // A worktree nothing is open on has no name of its own yet — the row
        // shows git's. Naming it is what opens it, so the row offers the same
        // control as one already open: the row itself opens it under the
        // directory's name, this under a chosen one (BR-08).
        renameLabel: "Open as workspace…",
        onRename: () => setPrompt({
          title: "Open this worktree as…",
          initial: t.name,
          submit: (name) => void api.addWorkspace(t.path, name, true, p.id).catch(report),
        }),
      })),
  ];

  /**
   * One row per root, disclosing its family: its worktrees, then the
   * repositories found in its folder, each disclosing its own worktrees. A
   * root with both gathers its worktrees under a `Worktrees` row (BR-13,
   * BR-13a). A child is found rather than added, so it offers Remove only
   * once its folder has gone (WS-16a, WS-20). Roots drag among roots and
   * children among their root's children (WS-18).
   */
  const rows: Row[] = roots.map((r) => {
    const worktrees = worktreeRows(r);
    const kids = childrenOf(r.id);
    const children = kids.map((c): Row => ({
      ...row(c, worktreeRows(c)),
      onRemove: c.available ? undefined : () => void remove(c),
      siblings: kids.length > 1 ? `kids:${r.id}` : undefined,
    }));
    const grouped = children.length && worktrees.length ? [{ id: `${r.id}:worktrees`, name: "Worktrees", children: worktrees }] : worktrees;
    return { ...row(r, [...grouped, ...children]), siblings: roots.length > 1 ? "top" : undefined };
  });

  /**
   * Puts a row before another of its list, or last (WS-11, WS-18). The whole
   * order goes to the backend, each root followed by its worktrees, then each
   * child followed by its own: an id left out would be moved to the end, and
   * the tray lists the same order.
   */
  const move = (id: string, before: string | null, siblings: string) => {
    const parent = siblings.startsWith("kids:") ? siblings.slice("kids:".length) : null;
    const list = (parent ? childrenOf(parent) : roots).map((w) => w.id);
    const order = list.filter((t) => t !== id);
    const at = before === null ? order.length : order.indexOf(before);
    if (at < 0 || !list.includes(id)) return;
    order.splice(at, 0, id);
    const withWorktrees = (t: string) => [t, ...worktreesOf(t).map((c) => c.id)];
    const kidsOf = (t: string) => (t === parent ? order : childrenOf(t).map((c) => c.id));
    const tops = parent ? roots.map((w) => w.id) : order;
    void api.reorderWorkspaces(tops.flatMap((t) => [...withWorktrees(t), ...kidsOf(t).flatMap(withWorktrees)])).catch(report);
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
          {session.workspaces.some(wants) && (
            <span className="attention-badge" title="A background workspace has new terminal output">●</span>
          )}
          {active?.available === false && <span className="switcher-path" title={active.path}>Missing: {active.path}</span>}
        </div>
        <ModeSelector ws={active} home={home} role={role} />
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
 * of the family on screen is running there — lit when one printed while out
 * of view. `home` is the family's root, which holds its shells (TERM-16).
 */
function ModeSelector({ ws, home, role }: { ws: Workspace | undefined; home: Workspace | undefined; role: WindowRole }) {
  const current = modeOf(ws, role);
  const shells = home?.terminals.length ?? 0;
  const waiting = home?.terminals.some((t) => t.attention) ?? false;
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
