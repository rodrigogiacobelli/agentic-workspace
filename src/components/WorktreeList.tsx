import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Session, Workspace, WorktreeEntry } from "../types";
import { Prompt } from "./Prompt";
import { report } from "./Switcher";

interface Props {
  ws: Workspace;
  session: Session;
  onClose: () => void;
}

type Step = { kind: "list" } | { kind: "path" } | { kind: "branch"; path: string };

/** Every worktree of the repository, with open, create, delete and prune. */
export function WorktreeList({ ws, session, onClose }: Props) {
  const [list, setList] = useState<WorktreeEntry[] | null>(null);
  const [step, setStep] = useState<Step>({ kind: "list" });

  const load = () => api.gitWorktrees(ws.id).then(setList).catch(report);
  useEffect(() => { void load(); }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const workspaceAt = (path: string) => session.workspaces.find((w) => w.path === path);

  const openAsWorkspace = async (wt: WorktreeEntry) => {
    const parent = ws.name.replace(/ \(wt: .*\)$/, "");
    await api.addWorkspace(wt.path, `${parent} (wt: ${wt.branch ?? wt.head ?? "detached"})`).catch(report);
    onClose();
  };

  const remove = async (wt: WorktreeEntry) => {
    const open = workspaceAt(wt.path);
    const dirty = await api.gitWorktreeDirty(wt.path).catch(() => []);
    const parts: string[] = [];
    if (open) {
      parts.push(`The workspace "${open.name}" is open in it${open.terminals.length ? ` with ${open.terminals.length} running terminal${open.terminals.length === 1 ? "" : "s"}` : ""}; it will be removed and its processes terminated.`);
    }
    if (dirty.length) parts.push(`It has ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}:\n${dirty.slice(0, 10).join("\n")}${dirty.length > 10 ? "\n…" : ""}`);
    const yes = await ask(`Delete the worktree at ${wt.path}?\n\n${parts.join("\n\n")}`.trim(), {
      title: "Delete worktree", kind: "warning", okLabel: "Delete", cancelLabel: "Keep",
    });
    if (!yes) return;
    try {
      if (open) await api.removeWorkspace(open.id);
      await api.gitRemoveWorktree(ws.id, wt.path, dirty.length > 0);
      await load();
    } catch (e) {
      report(e);
    }
  };

  const prune = async () => {
    const would = await api.gitPruneWorktrees(ws.id, true).catch((e) => { report(e); return [] as string[]; });
    if (would.length === 0) {
      window.dispatchEvent(new CustomEvent("app-notice", { detail: "Nothing to prune." }));
      return;
    }
    const yes = await ask(`Prune these worktree entries?\n\n${would.join("\n")}`, { title: "Prune worktrees", okLabel: "Prune", cancelLabel: "Keep" });
    if (yes) await api.gitPruneWorktrees(ws.id, false).then(load).catch(report);
  };

  const create = async (path: string, branch: string) => {
    const existing = await api.gitBranches(ws.id).then((b) => b.local.some((l) => l.name === branch)).catch(() => false);
    try {
      await api.gitAddWorktree(ws.id, path, branch, !existing);
      const openIt = await ask(`Worktree created at ${path}. Open it as a workspace?`, { title: "Worktree", okLabel: "Open as workspace", cancelLabel: "Not now" });
      if (openIt) await api.addWorkspace(path, `${ws.name.replace(/ \(wt: .*\)$/, "")} (wt: ${branch})`);
      onClose();
    } catch (e) {
      report(e);
      setStep({ kind: "list" });
    }
  };

  if (step.kind === "path") {
    return <Prompt title="Directory for the new worktree" initial={`${ws.path.replace(/\/+$/, "")}-`} onClose={() => setStep({ kind: "list" })} onSubmit={(path) => setStep({ kind: "branch", path })} />;
  }
  if (step.kind === "branch") {
    return <Prompt title="Branch (existing, or a new one to create)" onClose={() => setStep({ kind: "list" })} onSubmit={(branch) => void create(step.path, branch)} />;
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div className="dialog-title"><span>Worktrees</span><button onClick={onClose}>×</button></div>
        <div className="list-actions">
          <button onClick={() => setStep({ kind: "path" })}>＋ New worktree…</button>
          <button onClick={() => void prune()}>Prune</button>
        </div>
        <ul className="palette-list">
          {(list ?? []).map((wt) => {
            const open = workspaceAt(wt.path);
            return (
              <li key={wt.path} className={wt.path === ws.path ? "selected" : ""}>
                <span className="palette-label">{wt.branch ?? (wt.head ? `detached @ ${wt.head}` : "?")}{wt.isMain ? " (main)" : ""}</span>
                <span className="palette-detail" title={wt.path}>
                  {wt.path}{wt.locked ? " · locked" : ""}{wt.prunable ? " · prunable" : ""}{open ? ` · open as "${open.name}"` : ""}
                </span>
                {!open && !wt.prunable && <button className="row-action" title="Open as workspace" onClick={() => void openAsWorkspace(wt)}>Open</button>}
                {!wt.isMain && <button className="row-action" title="Delete worktree" onClick={() => void remove(wt)}>×</button>}
              </li>
            );
          })}
          {list && list.length === 0 && <li className="palette-empty">No worktrees</li>}
        </ul>
      </div>
    </div>
  );
}
