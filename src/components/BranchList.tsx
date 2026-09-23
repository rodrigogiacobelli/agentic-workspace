import { useEffect, useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { rank } from "../fuzzy";
import { useDismiss } from "../motion";
import type { Branches, RepoInfo, Session, Workspace } from "../types";
import { Palette } from "./Palette";
import { Prompt } from "./Prompt";
import { report } from "./Switcher";

interface Props {
  ws: Workspace;
  session: Session;
  info: RepoInfo;
  onClose: () => void;
}

type Step =
  | { kind: "list" }
  | { kind: "name" }
  | { kind: "start"; name: string }
  | { kind: "after"; name: string }
  | { kind: "worktree-path"; branch: string };

/** Local and remote branches; switch, create, delete, or start a worktree. */
export function BranchList({ ws, session, info, onClose }: Props) {
  const [branches, setBranches] = useState<Branches | null>(null);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [closing, dismiss] = useDismiss(onClose);

  const load = () => api.gitBranches(ws.id).then(setBranches).catch(report);
  useEffect(() => { void load(); }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const local = useMemo(() => rank(query, branches?.local ?? [], (b) => b.name, 500), [query, branches]);
  const remote = useMemo(() => rank(query, branches?.remote ?? [], (b) => b, 500), [query, branches]);

  const checkout = async (name: string) => {
    try {
      await api.gitCheckout(ws.id, name, false);
      onClose();
    } catch (e) {
      const text = String(e);
      const stash = await ask(`Git refused to switch:\n\n${text}\n\nStash the changes, switch, and re-apply them?`, {
        title: "Switch refused", kind: "warning", okLabel: "Stash and switch", cancelLabel: "Not now",
      });
      if (stash) {
        try { await api.gitCheckout(ws.id, name, true); onClose(); } catch (e2) { report(e2); }
        return;
      }
      const wt = await ask(`Create a worktree for ${name} instead, and open it as a workspace?`, {
        title: "Switch refused", kind: "info", okLabel: "Create worktree", cancelLabel: "Cancel",
      });
      if (wt) setStep({ kind: "worktree-path", branch: name });
    }
  };

  const createWorktree = async (branch: string, path: string) => {
    try {
      await api.gitAddWorktree(ws.id, path, branch, false);
      const openIt = await ask(`Worktree created at ${path}. Open it as a workspace?`, { title: "Worktree", okLabel: "Open as workspace", cancelLabel: "Not now" });
      if (openIt) await api.addWorkspace(path, `${ws.name} (wt: ${branch})`);
      onClose();
    } catch (e) {
      report(e);
    }
  };

  const remove = async (name: string) => {
    const unmerged = await api.gitUnmergedCommits(ws.id, name).catch(() => []);
    const detail = unmerged.length ? `\n\nThese commits would be lost:\n${unmerged.join("\n")}` : "";
    const yes = await ask(`Delete branch ${name}?${detail}`, { title: "Delete branch", kind: "warning", okLabel: unmerged.length ? "Force delete" : "Delete", cancelLabel: "Keep" });
    if (!yes) return;
    try {
      await api.gitDeleteBranch(ws.id, name, unmerged.length > 0);
      await load();
    } catch (e) {
      report(e);
    }
  };

  if (step.kind === "name") {
    return <Prompt title="New branch name" onClose={() => setStep({ kind: "list" })} onSubmit={(name) => setStep({ kind: "start", name })} />;
  }
  if (step.kind === "start") {
    return (
      <Prompt
        title="Start point (branch, tag or commit)"
        initial={info.branch ?? "HEAD"}
        onClose={() => setStep({ kind: "list" })}
        onSubmit={(start) => {
          api.gitCreateBranch(ws.id, step.name, start || null)
            .then(() => setStep({ kind: "after", name: step.name }))
            .catch((e) => { report(e); setStep({ kind: "list" }); });
        }}
      />
    );
  }
  if (step.kind === "after") {
    return (
      <Palette
        title={`Branch ${step.name} created — now?`}
        items={[
          { id: "switch", label: "Switch to it" },
          { id: "worktree", label: "Create a worktree for it" },
          { id: "nothing", label: "Nothing more" },
        ]}
        onClose={onClose}
        onPick={(item) => {
          if (item.id === "switch") void checkout(step.name);
          else if (item.id === "worktree") setStep({ kind: "worktree-path", branch: step.name });
          else onClose();
        }}
      />
    );
  }
  if (step.kind === "worktree-path") {
    const suggested = `${ws.path.replace(/\/+$/, "")}-${step.branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    return (
      <Prompt
        title="Directory for the worktree"
        initial={suggested}
        onClose={() => setStep({ kind: "list" })}
        onSubmit={(path) => void createWorktree(step.branch, path)}
      />
    );
  }

  const inWorkspace = (path: string) => session.workspaces.some((w) => w.path === path);

  return (
    <div className={`overlay${closing ? " is-closing" : ""}`} onMouseDown={dismiss}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") dismiss(); }}>
        <input autoFocus className="palette-input" placeholder="Branches — type to filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="list-actions">
          <button onClick={() => setStep({ kind: "name" })}>＋ New branch…</button>
        </div>
        <ul className="palette-list">
          {local.map((b) => (
            <li key={b.name} className={b.current ? "selected" : ""} onClick={() => { if (!b.current) void checkout(b.name); }}>
              <span className="palette-label">{b.current ? "● " : ""}{b.name}</span>
              <span className="palette-detail">
                {b.upstream ? `${b.upstream} ↑${b.ahead} ↓${b.behind}` : "no upstream"}
                {b.worktree && b.worktree !== ws.path ? ` · checked out in ${b.worktree}${inWorkspace(b.worktree) ? " (open)" : ""}` : ""}
              </span>
              {!b.current && <button className="row-action" title="Delete branch" onClick={(e) => { e.stopPropagation(); void remove(b.name); }}>×</button>}
            </li>
          ))}
          {remote.length > 0 && <li className="palette-empty">Remote branches</li>}
          {remote.map((r) => (
            <li key={r} onClick={() => void checkout(r.replace(/^[^/]+\//, ""))} title="Create a local branch tracking it">
              <span className="palette-label">{r}</span>
            </li>
          ))}
          {branches && local.length + remote.length === 0 && <li className="palette-empty">No branches</li>}
        </ul>
      </div>
    </div>
  );
}
