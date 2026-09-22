import { open } from "@tauri-apps/plugin-dialog";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Session, WindowRole } from "../types";

interface Props {
  session: Session;
  role: WindowRole;
  unsaved: number;
  onSettings: () => void;
}

/** The bar both windows share: which workspace is active, and the way out. */
export function Switcher({ session, role, unsaved, onSettings }: Props) {
  const active = session.workspaces.find((w) => w.id === session.active);
  const other: WindowRole = role === "terminal" ? "workspace" : "terminal";

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

  return (
    <header className="switcher">
      <select
        className="switcher-select"
        value={session.active ?? ""}
        onChange={(e) => void api.switchWorkspace(e.target.value).catch(report)}
        title={active?.path}
      >
        {session.workspaces.length === 0 && <option value="">No workspaces</option>}
        {session.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.attention ? "● " : ""}{w.name}{w.available ? "" : " (unavailable)"}
          </option>
        ))}
      </select>
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
      <span className="switcher-path">{active?.available === false ? `Missing: ${active.path}` : active?.path}</span>
      <button onClick={onSettings} title="Settings (Ctrl+,)">⚙</button>
      <button onClick={() => void api.focusWindow(other)} title="Focus the other window (Ctrl+Shift+Space)">
        {other === "terminal" ? "Terminal ▸" : "◂ Workspace"}
      </button>
    </header>
  );
}

export function report(e: unknown): void {
  console.error(e);
  window.dispatchEvent(new CustomEvent("app-notice", { detail: String(e) }));
}
