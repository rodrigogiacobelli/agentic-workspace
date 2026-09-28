import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { useChanged, useKept, useKeptScroll } from "../live";
import { rank } from "../fuzzy";
import { report } from "../notice";
import * as repo from "../repo";
import type { Branches, Session, Workspace } from "../types";
import { Icon } from "./icons";
import { Palette } from "./Palette";
import { Prompt } from "./Prompt";
import { addWorktree } from "./WorktreesPanel";

type Remote = "fetch" | "pull" | "push";

type Step =
  | { kind: "name" }
  | { kind: "start"; name: string }
  | { kind: "after"; name: string }
  | { kind: "worktree-path"; branch: string };

/** What a remote operation's button says while it runs, and its output when git printed nothing. */
const VERB: Record<Remote, { running: string; done: string }> = {
  fetch: { running: "Fetching…", done: "Fetched." },
  pull: { running: "Pulling…", done: "Pulled." },
  push: { running: "Pushing…", done: "Pushed." },
};

/**
 * Local and remote branches, and the operations that move them between the
 * two. Fetch, pull and push live here since Remote stopped being a panel of
 * its own, and git's whole output of the last one stays under them until it
 * is dismissed — a toast would show one line of it (GIT-17). The lists, the
 * filter and an operation's progress and output are kept, so one still running
 * when the panel is taken down shows how it ended when the panel is back.
 */
export function BranchesPanel({ ws, session }: { ws: Workspace; session: Session }) {
  const { info } = repo.useRepo(ws.id);
  const isRepo = info?.isRepo === true;
  const [branches, setBranches] = useKept<Branches | null>(`${ws.id}:branches:list`, null);
  const [query, setQuery] = useKept(`${ws.id}:branches:filter`, "");
  const [step, setStep] = useState<Step | null>(null);
  const [busy, setBusy] = useKept<Remote | null>(`${ws.id}:branches:busy`, null);
  const [output, setOutput] = useKept<{ text: string; failed: boolean } | null>(`${ws.id}:branches:output`, null);
  /** An operation ran from this panel since it was built: its box fades in, where a kept one is drawn in place. */
  const arriving = useRef(false);
  const scroller = useKeptScroll<HTMLDivElement>(`${ws.id}:branches:scroll`, branches !== null);

  const load = useCallback(() => api.gitBranches(ws.id).then(setBranches).catch(report), [ws.id, setBranches]);
  useEffect(() => { if (isRepo) void load(); }, [isRepo, load]);
  // An agent may branch from a terminal; the watcher says so.
  useChanged(ws.id, () => { if (isRepo) void load(); });

  const local = useMemo(() => rank(query, branches?.local ?? [], (b) => b.name, 500), [query, branches]);
  const remotes = useMemo(() => rank(query, branches?.remote ?? [], (b) => b, 500), [query, branches]);

  if (!info) return <div className="panel"><div className="tree-loading loading">Loading…</div></div>;
  if (!info.isRepo) return <div className="panel"><div className="panel-empty">{ws.name} is not inside a git repository.</div></div>;

  /** This list and every surface reading the repository store see the change. */
  const changed = () => { void load(); void repo.refresh(ws.id); };

  // A refused switch offers the two ways past it: carry the changes along in
  // a stash, or leave them where they are and check the branch out beside them.
  const checkout = async (name: string) => {
    try {
      await api.gitCheckout(ws.id, name, false);
    } catch (e) {
      // Stashing is offered only when there is something to stash: a switch
      // refused for any other reason — a branch held by another worktree —
      // would stash nothing and gain nothing.
      const dirty = repo.get(ws.id).status.length > 0;
      const stash = dirty && await ask(`Git refused to switch:\n\n${String(e)}\n\nStash the changes, switch, and re-apply them?`, {
        title: "Switch refused", kind: "warning", okLabel: "Stash and switch", cancelLabel: "Not now",
      });
      if (!dirty) report(e);
      if (stash) {
        // A stash that could not be re-applied is kept, and git says so in
        // the answer rather than as an error.
        await api.gitCheckout(ws.id, name, true).then((out) => { if (out.includes("could not be re-applied")) report(out); }).catch(report);
      } else if (await ask(`Create a worktree for ${name} instead, and open it as a workspace?`, {
        title: "Switch refused", kind: "info", okLabel: "Create worktree", cancelLabel: "Cancel",
      })) {
        setStep({ kind: "worktree-path", branch: name });
      }
    }
    changed();
  };

  // Forced whenever git could say which commits only this branch holds: the
  // prompt lists them, and a count of none means other refs hold every one,
  // so `-D` loses nothing. When git could not say, the plain delete leaves it
  // to refuse an unmerged branch.
  const remove = async (name: string) => {
    const unmerged = await api.gitUnmergedCommits(ws.id, name).catch(() => null);
    const count = unmerged?.count ?? 0;
    const commits = unmerged?.commits ?? [];
    const more = count > commits.length ? `\n…and ${count - commits.length} more` : "";
    const detail = count > 0 ? `\n\nThese commits would be lost:\n${commits.join("\n")}${more}` : "";
    const yes = await ask(`Delete branch ${name}?${detail}`, { title: "Delete branch", kind: "warning", okLabel: count > 0 ? "Force delete" : "Delete", cancelLabel: "Keep" });
    if (!yes) return;
    await api.gitDeleteBranch(ws.id, name, unmerged !== null).catch(report);
    changed();
  };

  // One at a time, since each moves the refs the others read; everything
  // else in the panel stays usable while it runs.
  const sync = async (action: Remote) => {
    setBusy(action);
    arriving.current = true;
    setOutput({ text: VERB[action].running, failed: false });
    try {
      const out = await api.gitRemote(ws.id, action, action === "push" && !info.upstream);
      setOutput({ text: out.trim() || VERB[action].done, failed: false });
    } catch (e) {
      setOutput({ text: String(e), failed: true });
    } finally {
      setBusy(null);
      changed();
    }
  };

  const op = (action: Remote, label: ReactNode, title: string) => (
    <button className="remote-op" disabled={!!busy} aria-busy={busy === action} title={title} onClick={() => void sync(action)}>
      {busy === action ? VERB[action].running : label}
    </button>
  );

  const openAt = (path: string) => session.workspaces.some((w) => w.path === path);

  return (
    <div className="panel">
      <div className="panel-bar">
        {op("fetch", "Fetch", "Fetch every remote, pruning branches deleted there")}
        {op("pull", <>{info.behind > 0 && <span className="behind">↓{info.behind}</span>}Pull</>, info.upstream ? `Pull from ${info.upstream}` : "Pull")}
        {op("push", <>{info.ahead > 0 && <span className="ahead">↑{info.ahead}</span>}Push</>, info.upstream ? `Push to ${info.upstream}` : "Push, and set the upstream")}
        <button title="New branch…" onClick={() => setStep({ kind: "name" })}>＋</button>
      </div>
      {output && (
        <div className={`remote-output${output.failed ? " failed" : ""}${arriving.current ? " arriving" : ""}`}>
          <pre>{output.text}</pre>
          <button title="Dismiss" onClick={() => setOutput(null)}><Icon name="close" size={12} /></button>
        </div>
      )}
      <div className="panel-bar">
        <input placeholder="Filter branches" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div ref={scroller} className="panel-list">
        {!branches && <div className="tree-loading loading">Loading…</div>}
        {local.length > 0 && (
          <div className="git-section">
            <div className="git-section-title"><span>Local <span className="search-count">{local.length}</span></span></div>
            {local.map((b) => {
              const elsewhere = b.worktree && b.worktree !== ws.path ? b.worktree : null;
              const detail = `${b.upstream ?? "no upstream"}${elsewhere ? ` · checked out in ${elsewhere}${openAt(elsewhere) ? " (open)" : ""}` : ""}`;
              return (
                <div key={b.name} className={`git-row${b.current ? " plain" : ""}`} title={`${b.name}\n${detail}`} onClick={() => { if (!b.current) void checkout(b.name); }}>
                  <span className={`ref-mark${b.current ? " on" : ""}`}>{b.current ? "●" : "○"}</span>
                  <span className="ref-name">{b.name}</span>
                  <span className="git-dir">{detail}</span>
                  {(b.ahead > 0 || b.behind > 0) && (
                    <span className="ref-ab">
                      {b.ahead > 0 && <span className="ahead">↑{b.ahead}</span>}
                      {b.behind > 0 && <span className="behind">↓{b.behind}</span>}
                    </span>
                  )}
                  {!b.current && (
                    <span className="git-actions" onClick={(e) => e.stopPropagation()}>
                      <button title="Delete branch" onClick={() => void remove(b.name)}><Icon name="close" size={13} /></button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {remotes.length > 0 && (
          <div className="git-section">
            <div className="git-section-title"><span>Remote <span className="search-count">{remotes.length}</span></span></div>
            {remotes.map((r) => (
              <div key={r} className="git-row" title={`Create a local branch tracking ${r}`} onClick={() => void checkout(r.replace(/^[^/]+\//, ""))}>
                <span className="ref-mark" />
                <span className="ref-name">{r}</span>
              </div>
            ))}
          </div>
        )}
        {branches && local.length + remotes.length === 0 && <div className="panel-empty">{query ? "No branch matches." : "No branches yet."}</div>}
      </div>
      {step?.kind === "name" && (
        <Prompt title="New branch name" onClose={() => setStep(null)} onSubmit={(name) => setStep({ kind: "start", name })} />
      )}
      {step?.kind === "start" && (
        <Prompt
          title="Start point (branch, tag or commit)"
          initial={info.branch ?? "HEAD"}
          onClose={() => setStep(null)}
          onSubmit={(start) => {
            api.gitCreateBranch(ws.id, step.name, start || null)
              .then(() => { setStep({ kind: "after", name: step.name }); changed(); })
              .catch((e) => { report(e); setStep(null); });
          }}
        />
      )}
      {step?.kind === "after" && (
        <Palette
          title={`Branch ${step.name} created — now?`}
          items={[
            { id: "switch", label: "Switch to it" },
            { id: "worktree", label: "Create a worktree for it" },
            { id: "nothing", label: "Nothing more" },
          ]}
          onClose={() => setStep(null)}
          onPick={(item) => {
            if (item.id === "worktree") { setStep({ kind: "worktree-path", branch: step.name }); return; }
            setStep(null);
            if (item.id === "switch") void checkout(step.name);
          }}
        />
      )}
      {step?.kind === "worktree-path" && (
        <Prompt
          title="Directory for the worktree"
          initial={`${ws.path.replace(/\/+$/, "")}-${step.branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`}
          onClose={() => setStep(null)}
          onSubmit={(path) => {
            addWorktree(ws, path, step.branch, false)
              .then(() => { setStep(null); changed(); })
              .catch(report);
          }}
        />
      )}
    </div>
  );
}
