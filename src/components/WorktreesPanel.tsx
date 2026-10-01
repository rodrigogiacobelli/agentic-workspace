import { useCallback, useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { useChanged, useKept, useKeptScroll } from "../live";
import { familyRoot } from "../modes";
import { notify, report } from "../notice";
import * as repo from "../repo";
import type { Session, Unmerged, Workspace, WorktreeEntry } from "../types";
import { Confirm } from "./Confirm";
import { Icon } from "./icons";
import { Prompt } from "./Prompt";

type Step = { kind: "path" } | { kind: "branch"; path: string };

/** A worktree removal waiting on its confirmation, with what was found before asking. */
interface Removal {
  wt: WorktreeEntry;
  force: boolean;
  message: string;
  /** The branch the confirmation offers to delete too, and the commits it counted as lost with it. */
  branch: { name: string; unique: Unmerged; detail?: string } | null;
  /** The terminal tabs the confirmation named as closing with it (TERM-22). */
  shells: string[];
}

/** `lore (wt: refactor)`: the parent project's own name, never a worktree's, then the branch (BR-08). */
const worktreeName = (ws: Workspace, label: string) => `${ws.name.replace(/ \(wt: .*\)$/, "")} (wt: ${label})`;

/** The repository row a worktree opened from Source Control goes under: the
 *  workspace on screen, or its row when it is a worktree itself (assumption 4). */
const rowOf = (ws: Workspace) => ws.worktreeOf ?? ws.id;

/**
 * Adds a worktree and offers to open it as a workspace. The workspace is
 * marked as derived from git's list, as the selector's worktree rows are, so
 * it closes with its directory. Throws when git refuses the worktree.
 */
export async function addWorktree(ws: Workspace, path: string, branch: string, create: boolean): Promise<void> {
  await api.gitAddWorktree(ws.id, path, branch, create);
  const openIt = await ask(`Worktree created at ${path}. Open it as a workspace?`, { title: "Worktree", okLabel: "Open as workspace", cancelLabel: "Not now" });
  if (openIt) await api.addWorkspace(path, worktreeName(ws, branch), true, rowOf(ws)).catch(report);
}

/**
 * Every worktree of the repository, with open, switch, create, delete and
 * prune. The list is kept, so the panel rebuilt when it comes back paints it
 * at once and reads it again behind it.
 */
export function WorktreesPanel({ ws, session }: { ws: Workspace; session: Session }) {
  const { info } = repo.useRepo(ws.id);
  const isRepo = info?.isRepo === true;
  const [list, setList] = useKept<WorktreeEntry[] | null>(`${ws.id}:worktrees:list`, null);
  const [step, setStep] = useState<Step | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const scroller = useKeptScroll<HTMLDivElement>(`${ws.id}:worktrees:scroll`, list !== null);

  const load = useCallback(() => api.gitWorktrees(ws.id).then(setList).catch(report), [ws.id, setList]);
  useEffect(() => { if (isRepo) void load(); }, [isRepo, load]);
  // An agent may add a worktree from a terminal; the watcher says so.
  useChanged(ws.id, () => { if (isRepo) void load(); });

  if (!info) return <div className="panel"><div className="tree-loading loading">Loading…</div></div>;
  if (!info.isRepo) return <div className="panel"><div className="panel-empty">{ws.name} is not inside a git repository.</div></div>;

  /** This list and every surface reading the repository store see the change. */
  const changed = () => { void load(); void repo.refresh(ws.id); };
  /** The workspace open on a path; on a folder open twice — a repository the
   *  owner added and a child on it — the one of this family (assumption 3). */
  const workspaceAt = (path: string) => {
    const home = familyRoot(session.workspaces, ws)?.id;
    const on = session.workspaces.filter((w) => w.path === path);
    return on.find((w) => familyRoot(session.workspaces, w)?.id === home) ?? on[0];
  };

  const openAsWorkspace = (wt: WorktreeEntry) =>
    void api.addWorkspace(wt.path, worktreeName(ws, wt.branch ?? wt.head ?? "detached"), true, rowOf(ws)).catch(report);

  const remove = async (wt: WorktreeEntry) => {
    const open = workspaceAt(wt.path);
    const dirty = await api.gitWorktreeDirty(wt.path).catch(() => []);
    // Every shell inside the worktree, of any family, by the directory
    // `/proc` gives now: reading the session reads each one again. A
    // worktree open as a root of its own holds a list of its own, wherever
    // its shells are, and its removal closes all of them (TERM-22).
    const fresh = await api.getSession().catch(() => session);
    const root = wt.path.replace(/\/+$/, "");
    const shells = fresh.workspaces.flatMap((w) => w.terminals
      .filter((t) => w.id === open?.id || t.cwd === root || t.cwd.startsWith(`${root}/`))
      .map((t) => ({ id: t.id, label: `${t.name ?? t.cwd.slice(t.cwd.lastIndexOf("/") + 1)} (${w.name})` })));
    const parts: string[] = [];
    if (open) parts.push(`The workspace "${open.name}" is open in it; it will be removed.`);
    if (shells.length) {
      const one = shells.length === 1;
      parts.push(`${one ? "This terminal" : `These ${shells.length} terminals`} will be closed and ${one ? "its process" : "their processes"} terminated:\n${shells.map((s) => s.label).join("\n")}`);
    }
    if (dirty.length) parts.push(`It has ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}:\n${dirty.slice(0, 10).join("\n")}${dirty.length > 10 ? "\n…" : ""}`);
    // The branch goes too only if nothing else has it checked out — git would
    // refuse — and only once git has said what deleting it loses: a count it
    // could not give leaves the branch out of the question (GIT-22).
    const name = wt.branch && !list?.some((o) => o.path !== wt.path && o.branch === wt.branch) ? wt.branch : null;
    const unique = name ? await api.gitUnmergedCommits(ws.id, name).catch(() => null) : null;
    setRemoval({
      wt,
      force: dirty.length > 0,
      message: `Delete the worktree at ${wt.path}?\n\n${parts.join("\n\n")}`.trim(),
      branch: name && unique
        ? { name, unique, detail: unique.count > 0 ? `${name} has ${unique.count} commit${unique.count === 1 ? "" : "s"} no other branch holds. Deleting it loses them.` : undefined }
        : null,
      shells: shells.map((s) => s.id),
    });
  };

  // The shells named, the workspace and the worktree go together, and git's
  // refusal is surfaced rather than overridden (BR-10). The workspace is the
  // one open on the worktree now: the Terminal window's switcher can open or
  // remove one while the question is up. The branch is deleted only once the
  // worktree is gone, and forced, but only over the commits the confirmation
  // counted: a shell in the worktree kept running while it was asked, and a
  // commit made meanwhile keeps the branch.
  const removeConfirmed = async ({ wt, force, branch, shells }: Removal, withBranch: boolean) => {
    try {
      for (const id of shells) await api.terminalClose(id);
      const open = workspaceAt(wt.path);
      if (open) await api.removeWorkspace(open.id);
      await api.gitRemoveWorktree(ws.id, wt.path, force);
      if (withBranch && branch) {
        const now = await api.gitUnmergedCommits(ws.id, branch.name).catch(() => null);
        if (now && now.count <= branch.unique.count && now.commits.every((c) => branch.unique.commits.includes(c))) {
          await api.gitDeleteBranch(ws.id, branch.name, true);
        } else {
          report(`The branch ${branch.name} is kept: ${now ? "it holds commits made after the confirmation" : "git could not count its commits again"}.`);
        }
      }
    } catch (e) {
      report(e);
    }
    changed();
  };

  const prune = async () => {
    const would = await api.gitPruneWorktrees(ws.id, true).catch((e) => { report(e); return null; });
    if (!would) return;
    if (would.length === 0) {
      notify("Nothing to prune.");
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
      <div ref={scroller} className="panel-list">
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
      {removal && (
        <Confirm
          key={removal.wt.path}
          title="Delete worktree"
          message={removal.message}
          checkbox={removal.branch ? { label: `Also delete branch ${removal.branch.name}`, detail: removal.branch.detail } : undefined}
          ok="Delete"
          cancel="Keep"
          onClose={(ok, checked) => { setRemoval(null); if (ok) void removeConfirmed(removal, checked); }}
        />
      )}
    </div>
  );
}
