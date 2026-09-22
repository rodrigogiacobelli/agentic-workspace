import { open } from "@tauri-apps/plugin-dialog";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, events } from "../api";
import { report } from "../notice";
import type { Session, WindowRole, Workspace } from "../types";
import { Icon } from "./icons";
import { RowMenu } from "./Menu";
import { PanelsMenu } from "./PanelsMenu";
import { Prompt } from "./Prompt";

export { report };

interface Props {
  session: Session;
  role: WindowRole;
  unsaved: number;
  onSettings: () => void;
}

/**
 * The one row both windows carry in place of the compositor's title bar: the
 * path on the left, the workspace selector in the middle, and the View menu,
 * settings, the other window and the window controls on the right. Empty
 * parts of it drag the window and double-click maximises it.
 */
export function Switcher({ session, role, unsaved, onSettings }: Props) {
  const active = session.workspaces.find((w) => w.id === session.active);
  const other: WindowRole = role === "terminal" ? "workspace" : "terminal";
  const [renaming, setRenaming] = useState<Workspace | null>(null);
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
    if (w.terminals.length) parts.push(`${w.terminals.length} terminal tab${w.terminals.length === 1 ? "" : "s"} will be closed and their processes terminated`);
    if (w.id === session.active && unsaved) parts.push(`${unsaved} unsaved editor buffer${unsaved === 1 ? "" : "s"} will be lost`);
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
          <span className="switcher-path" title={active?.path}>{active?.available === false ? `Missing: ${active.path}` : active?.path}</span>
          {active?.git?.isRepo && (
            <span className="switcher-branch" title={active.git.state ? `${active.git.state} in progress` : "Current branch"}>
              ⑂ {active.git.detached ? "detached @ " : ""}{active.git.branch ?? ""}{active.git.state ? ` · ${active.git.state}` : ""}
            </span>
          )}
        </div>
        <div className="switcher-center">
          <RowMenu
            className="switcher-select"
            label={label}
            title={active?.path}
            minWidth={340}
            rows={session.workspaces.map((w) => ({
              id: w.id,
              name: `${w.attention && w.id !== session.active ? "● " : ""}${w.name}${w.available ? "" : " (unavailable)"}`,
              detail: w.path,
              selected: w.id === session.active,
              onPick: () => { if (w.id !== session.active) void api.switchWorkspace(w.id).catch(report); },
              onRename: () => setRenaming(w),
              onRemove: () => void remove(w),
            }))}
            footer={{ label: "＋ Add folder…", onClick: () => void addFolder() }}
            empty="No workspaces yet"
          />
          {session.workspaces.some((w) => w.attention && w.id !== session.active) && (
            <span className="attention-badge" title="A background workspace has new terminal output">●</span>
          )}
        </div>
        <div className="switcher-right">
          {role === "workspace" && <PanelsMenu />}
          <button onClick={onSettings} title="Settings (Ctrl+,)">⚙</button>
          <button onClick={() => void api.focusWindow(other).catch(report)} title={`${other === "terminal" ? "Terminal window" : "Workspace window"} (Ctrl+Shift+Space)`}>
            <Icon name={other === "terminal" ? "terminal" : "workspace"} />
          </button>
          <span className="win-controls">
            <button onClick={() => void api.windowMinimize()} title="Minimise">−</button>
            <button onClick={() => void api.windowToggleMaximize()} title={maximized ? "Restore" : "Maximise"}>{maximized ? "❐" : "□"}</button>
            <button className="close" onClick={() => void api.windowClose()} title="Close (the app stays in the tray)">✕</button>
          </span>
        </div>
      </header>
      {!maximized && <ResizeEdges />}
      {renaming && (
        <Prompt
          title="Workspace name"
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => { const w = renaming; setRenaming(null); void api.renameWorkspace(w.id, name).catch(report); }}
        />
      )}
    </>
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
