import { useCallback, useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { useChanged } from "../live";
import { report } from "../notice";
import * as repo from "../repo";
import type { Session, Workspace, WorktreeEntry } from "../types";
import { Icon } from "./icons";
import { Prompt } from "./Prompt";

type Step = { kind: "path" } | { kind: "branch"; path: string };

/** `lore (wt: refactor)`: the parent project's own name, never a worktree's, then the branch (BR-08). */
const worktreeName = (ws: Workspace, label: string) => `${ws.name.replace(/ \(wt: .*\)$/, "")} (wt: ${label})`;

/**
 * Adds a worktree and offers to open it as a workspace. The workspace is
 * marked as derived from git's list, as the selector's worktree rows are, so
 * it closes with its directory. Throws when git refuses the worktree.
 */
export async function addWorktree(ws: Workspace, path: string, branch: string, create: boolean): Promise<void> {
  await api.gitAddWorktree(ws.id, path, branch, create);
  const openIt = await ask(`Worktree created at ${path}. Open it as a workspace?`, { title: "Worktree", okLabel: "Open as workspace", cancelLabel: "Not now" });
  if (openIt) await api.addWorkspace(path, worktreeName(ws, branch), true).catch(report);
}

/** Every worktree of the repository, with open, switch, create, delete and prune. */
export function WorktreesPanel({ ws, session }: { ws: Workspace; session: Session }) {
  const { info } = repo.useRepo(ws.id);
  const isRepo = info?.isRepo === true;
  const [list, setList] = useState<WorktreeEntry[] | null>(null);
  const [step, setStep] = useState<Step | null>(null);

  const load = useCallback(() => api.gitWorktrees(ws.id).then(setList).catch(report), [ws.id]);
  useEffect(() => { if (isRepo) void load(); }, [isRepo, load]);
  // An agent may add a worktree from a terminal; the watcher says so.
  useChanged(ws.id, () => { if (isRepo) void load(); });

  if (!info) return <div className="panel"><div className="tree-loading loading">Loading…</div></div>;
  if (!info.isRepo) return <div className="panel"><div className="panel-empty">{ws.name} is not inside a git repository.</div></div>;

  /** This list and every surface reading the repository store see the change. */
  const changed = () => { void load(); void repo.refresh(ws.id); };
  const workspaceAt = (path: string) => session.workspaces.find((w) => w.path === path);

  const openAsWorkspace = (wt: WorktreeEntry) =>
    void api.addWorkspace(wt.path, worktreeName(ws, wt.branch ?? wt.head ?? "detached"), true).catch(report);

  // The workspace, its processes and the worktree go together, and git's
  // refusal is surfaced rather than overridden (BR-10).
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
    } catch (e) {
      report(e);
    }
    changed();
  };

  const prune = async () => {
    const would = await api.gitPruneWorktrees(ws.id, true).catch((e) => { report(e); return null; });
    if (!would) return;
    if (would.length === 0) {
      window.dispatchEvent(new CustomEvent("app-notice", { detail: "Nothing to prune." }));
      return;
    }
    const yes = await ask(`Prune these worktree entries?\n\n${would.join("\n")}`, { title: "Prune worktrees", okLabel: "Prune", cancelLabel: "Keep" });
    if (!yes) return;
    await api.gitPruneWorktrees(ws.id, false).catch(report);
    changed();
  };

  const create = async (path: string, branch: string) => {
    setStep(null);
    const existing = await api.gitBranches(ws.id).then((b) => b.local.some((l) => l.name === branch)).catch(() => false);
    await addWorktree(ws, path, branch, !existing).catch(report);
    changed();
  };

  return (
    <div className="panel">
      <div className="panel-bar">
        <button onClick={() => setStep({ kind: "path" })}>＋ New worktree…</button>
        <button onClick={() => void prune()} title="Remove the entries of worktrees whose directories are gone (BR-11)">Prune</button>
      </div>
      <div className="panel-list">
        {!list && <div className="tree-loading loading">Loading…</div>}
        {list?.map((wt) => {
          const open = workspaceAt(wt.path);
          const here = wt.path === ws.path;
          return (
            <div key={wt.path} className="git-row plain wt-row" title={wt.path}>
              <span className={`ref-mark${here ? " on" : ""}`}>{here ? "●" : "○"}</span>
              <span className="wt-line">
                <span className="ref-name">{wt.branch ?? `detached @ ${wt.head ?? "?"}`}</span>
                {wt.isMain && <span className="ref-pill">main</span>}
                {wt.locked && <span className="ref-pill warn">locked</span>}
                {wt.prunable && <span className="ref-pill gone" title="Its directory is gone; Prune removes the entry">prunable</span>}
                {open && <span className="ref-pill open" title={`Open as the workspace "${open.name}"`}>{open.name}</span>}
              </span>
              <span className="wt-path">{wt.path}</span>
              <span className="git-actions">
                {!open && !wt.prunable && <button title="Open as a workspace" onClick={() => openAsWorkspace(wt)}>Open</button>}
                {open && !here && <button title={`Switch to "${open.name}"`} onClick={() => void api.switchWorkspace(open.id).catch(report)}>Switch</button>}
                {/* Not the one this workspace is on: deleting it removes this
                    workspace first, and the removal has to run from one
                    that outlives it. */}
                {!wt.isMain && !here && <button title="Delete worktree" onClick={() => void remove(wt)}><Icon name="close" size={13} /></button>}
              </span>
            </div>
          );
        })}
      </div>
      {step?.kind === "path" && (
        <Prompt
          title="Directory for the new worktree"
          initial={`${ws.path.replace(/\/+$/, "")}-`}
          onClose={() => setStep(null)}
          onSubmit={(path) => setStep({ kind: "branch", path })}
        />
      )}
      {step?.kind === "branch" && (
        <Prompt title="Branch (existing, or a new one to create)" onClose={() => setStep(null)} onSubmit={(branch) => void create(step.path, branch)} />
      )}
    </div>
  );
}
