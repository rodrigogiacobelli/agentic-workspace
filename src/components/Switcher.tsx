import { open } from "@tauri-apps/plugin-dialog";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, events } from "../api";
import type { Session, WindowRole } from "../types";
import { Dropdown } from "./Menu";
import { Prompt } from "./Prompt";

interface Props {
  session: Session;
  role: WindowRole;
  unsaved: number;
  onSettings: () => void;
}

/**
 * The one row both windows carry in place of the compositor's title bar:
 * which workspace is active, the way to the other window, and the window
 * controls. Empty parts of it drag the window and double-click maximises it.
 */
export function Switcher({ session, role, unsaved, onSettings }: Props) {
  const active = session.workspaces.find((w) => w.id === session.active);
  const other: WindowRole = role === "terminal" ? "workspace" : "terminal";
  const [renaming, setRenaming] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const check = () => api.windowMaximized().then(setMaximized).catch(() => {});
    void check();
    const unlisten = events.onWindowResized(() => void check());
    return () => { void unlisten.then((u) => u()); };
  }, []);

  const addFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Add a workspace folder" });
    if (typeof picked === "string") await api.addWorkspace(picked).catch(report);
  };

  const remove = async () => {
    if (!active) return;
    const parts = [];
    if (active.terminals.length) parts.push(`${active.terminals.length} terminal tab${active.terminals.length === 1 ? "" : "s"} will be closed and their processes terminated`);
    if (unsaved) parts.push(`${unsaved} unsaved editor buffer${unsaved === 1 ? "" : "s"} will be lost`);
    const detail = parts.length ? `\n\n${parts.join(".\n")}.` : "";
    const yes = await ask(`Remove workspace "${active.name}"?${detail}\n\nNo file on disk is deleted.`, {
      title: "Remove workspace",
      kind: "warning",
      okLabel: "Remove",
      cancelLabel: "Keep",
    });
    if (yes) await api.removeWorkspace(active.id).catch(report);
  };

  const options = session.workspaces.length
    ? session.workspaces.map((w) => ({ id: w.id, label: `${w.attention && w.id !== session.active ? "● " : ""}${w.name}${w.available ? "" : " (unavailable)"}`, detail: w.path }))
    : [{ id: "", label: "No workspaces" }];

  return (
    <>
      <header className="switcher" data-tauri-drag-region="deep">
        <Dropdown
          className="switcher-select"
          value={session.active ?? ""}
          options={options}
          onChange={(id) => void api.switchWorkspace(id).catch(report)}
          title={active?.path}
        />
        {session.workspaces.some((w) => w.attention && w.id !== session.active) && (
          <span className="attention-badge" title="A background workspace has new terminal output">●</span>
        )}
        {active?.git?.isRepo && (
          <span className="switcher-branch" title={active.git.state ? `${active.git.state} in progress` : "Current branch"}>
            ⑂ {active.git.detached ? "detached @ " : ""}{active.git.branch ?? ""}{active.git.state ? ` · ${active.git.state}` : ""}
          </span>
        )}
        <button onClick={() => void addFolder()} title="Add folder…">＋</button>
        {active && <button onClick={() => void remove()} title="Remove this workspace">－</button>}
        {active && <button onClick={() => setRenaming(true)} title="Rename this workspace">✎</button>}
        <span className="switcher-path">{active?.available === false ? `Missing: ${active.path}` : active?.path}</span>
        <button onClick={onSettings} title="Settings (Ctrl+,)">⚙</button>
        <button onClick={() => void api.focusWindow(other).catch(report)} title="Focus the other window (Ctrl+Shift+Space)">
          {other === "terminal" ? "Terminal ▸" : "◂ Workspace"}
        </button>
        <span className="win-controls">
          <button onClick={() => void api.windowMinimize()} title="Minimise">−</button>
          <button onClick={() => void api.windowToggleMaximize()} title={maximized ? "Restore" : "Maximise"}>{maximized ? "❐" : "□"}</button>
          <button className="close" onClick={() => void api.windowClose()} title="Close (the app stays in the tray)">✕</button>
        </span>
      </header>
      {renaming && active && (
        <Prompt
          title="Workspace name"
          initial={active.name}
          onClose={() => setRenaming(false)}
          onSubmit={(name) => { setRenaming(false); void api.renameWorkspace(active.id, name).catch(report); }}
        />
      )}
    </>
  );
}

export function report(e: unknown): void {
  console.error(e);
  window.dispatchEvent(new CustomEvent("app-notice", { detail: String(e) }));
}
