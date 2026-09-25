import { useState, type ReactNode } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { useKept, useKeptScroll } from "../live";
import { report } from "../notice";
import * as repo from "../repo";
import type { DiffSpec, Stash, StatusEntry, Workspace } from "../types";
import { MenuButton } from "./Menu";
import { Prompt } from "./Prompt";

interface Props {
  ws: Workspace;
  onDiff: (path: string, diff: DiffSpec) => void;
  onOpenFile: (path: string) => void;
}

type Kind = "staged" | "changed" | "untracked" | "conflicted";

/** Git's convention for a subject line; past it the counter warns and nothing else happens (GIT-20). */
const SUBJECT = 50;

/** A path as a file row shows it: the name, then its directory dimmed. */
export function PathLabel({ path }: { path: string }) {
  const i = path.lastIndexOf("/");
  return (
    <>
      <span className="git-path">{path.slice(i + 1)}</span>
      {i !== -1 && <span className="git-dir">{path.slice(0, i)}</span>}
    </>
  );
}

/**
 * What the working tree holds against HEAD, the stashes beside it, and the
 * box that commits. The message, the amend switch, the folded sections and an
 * operation still running are kept, so the panel rebuilt when its workspace or
 * mode comes back shows them as they were left.
 */
export function CommitPanel({ ws, onDiff, onOpenFile }: Props) {
  const { info, status, stashes } = repo.useRepo(ws.id);
  const [message, setMessage] = useKept(`${ws.id}:commit:message`, "");
  const [amend, setAmend] = useKept(`${ws.id}:commit:amend`, false);
  const [busy, setBusy] = useKept<string | null>(`${ws.id}:commit:busy`, null);
  const [collapsed, setCollapsed] = useKept<Set<string>>(`${ws.id}:commit:collapsed`, new Set());
  const [naming, setNaming] = useState(false);
  const scroller = useKeptScroll<HTMLDivElement>(`${ws.id}:commit:scroll`, info !== null);

  if (!info) return <div className="tree-loading loading">Loading…</div>;
  if (!info.isRepo) {
    return (
      <div className="panel-empty">
        <div>{ws.name} is not inside a git repository.</div>
        <button onClick={() => api.gitInit(ws.id).then(() => repo.refresh(ws.id)).catch(report)}>Initialise repository</button>
      </div>
    );
  }

  const staged = status.filter((s) => !s.untracked && !s.conflicted && s.index !== ".");
  const changed = status.filter((s) => !s.untracked && !s.conflicted && s.worktree !== ".");
  const untracked = status.filter((s) => s.untracked);
  const conflicted = status.filter((s) => s.conflicted);
  const dirty = status.length > 0;
  const ready = !busy && (amend || staged.length > 0);
  const subject = message.split("\n", 1)[0].length;

  // `busy` holds until the re-read lands, not only until git answers: a drop
  // renumbers every stash after it, and the next click must act on the new list.
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); } catch (e) { report(e); } finally { await repo.refresh(ws.id); setBusy(null); }
  };

  // No notice on success: the Staged section emptying and History gaining the
  // commit are the acknowledgement. A notice carries a failure only.
  const commit = () => {
    if (!ready) return;
    if (!message.trim()) { report("Type a commit message first."); return; }
    // The box stays live while hooks run; only the text committed is cleared.
    const sent = message;
    void run("commit", async () => {
      await api.gitCommit(ws.id, sent, amend);
      setMessage((m) => (m === sent ? "" : m));
      setAmend(false);
    });
  };

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && !message.trim()) setMessage(await api.gitLastMessage(ws.id).catch(() => ""));
  };

  const discard = async (entry: StatusEntry) => {
    const yes = await ask(
      entry.untracked ? `Move ${entry.path} to the trash?` : `Discard the changes to ${entry.path}? This cannot be undone.`,
      { title: "Discard changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep" },
    );
    if (yes) await run("discard", () => api.gitDiscard(ws.id, entry.path, entry.untracked));
  };

  const drop = async (stash: Stash) => {
    const yes = await ask(`Drop the stash “${stash.message}”? This cannot be undone.`, { title: "Drop stash", kind: "warning", okLabel: "Drop", cancelLabel: "Keep" });
    if (yes) await run("stash", () => api.gitStashDrop(ws.id, stash.hash));
  };

  const toggle = (title: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (!next.delete(title)) next.add(title);
    return next;
  });

  const row = (entry: StatusEntry, kind: Kind) => {
    const letter = kind === "staged" ? entry.index : kind === "conflicted" ? "!" : entry.untracked ? "U" : entry.worktree;
    return (
      <div
        key={`${kind}:${entry.path}`}
        className="git-row"
        onClick={() => onDiff(entry.path, kind === "staged" ? { kind: "staged", hash: null, untracked: false } : { kind: "worktree", hash: null, untracked: entry.untracked })}
        title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}
      >
        <span className={`git-letter s-${letter}`}>{letter}</span>
        <PathLabel path={entry.path} />
        <span className="git-actions" onClick={(e) => e.stopPropagation()}>
          <button title="Open file" onClick={() => onOpenFile(entry.path)}>⤴</button>
          {kind === "staged" ? (
            <button title="Unstage" onClick={() => void run("unstage", () => api.gitUnstage(ws.id, [entry.path]))}>−</button>
          ) : (
            <>
              {kind !== "conflicted" && <button title="Discard" onClick={() => void discard(entry)}>↶</button>}
              <button title="Stage" onClick={() => void run("stage", () => api.gitStage(ws.id, [entry.path]))}>+</button>
            </>
          )}
        </span>
      </div>
    );
  };

  // A stash has no diff to open from here; its row carries what can be done
  // with it. Apply keeps the entry and Pop drops it once applied (GIT-18).
  const stashRow = (stash: Stash) => (
    <div key={stash.hash} className="git-row stash" title={`stash@{${stash.index}}`}>
      <span className="git-letter stash">≡</span>
      <span className="git-path">{stash.message}</span>
      <span className="git-dir">{stash.date}</span>
      <span className="git-actions">
        <button title="Apply the changes and keep the stash" disabled={!!busy} onClick={() => void run("stash", () => api.gitStashApply(ws.id, stash.hash, false))}>Apply</button>
        <button title="Apply the changes and drop the stash" disabled={!!busy} onClick={() => void run("stash", () => api.gitStashApply(ws.id, stash.hash, true))}>Pop</button>
        <button title="Delete the stash" disabled={!!busy} onClick={() => void drop(stash)}>Drop</button>
      </span>
    </div>
  );

  const section = (title: string, count: number, rows: ReactNode, action?: { label: string; run: () => void }) => {
    const open = !collapsed.has(title);
    return (
      <div className="git-section">
        <div className="git-section-title">
          <button className="git-section-toggle" aria-expanded={open} onClick={() => toggle(title)}>
            <span className={`git-chevron${open ? " open" : ""}`}>▸</span>
            {title} <span className="search-count">{count}</span>
          </button>
          {action && <button onClick={action.run} disabled={!!busy}>{action.label}</button>}
        </div>
        {open && rows}
      </div>
    );
  };

  const files = (title: string, entries: StatusEntry[], kind: Kind, action?: { label: string; run: () => void }) =>
    entries.length > 0 && section(title, entries.length, entries.map((e) => row(e, kind)), action);

  return (
    <div className="panel">
      {info.isWorktree && <div className="panel-note">Worktree of {info.mainWorktree}</div>}
      {info.state && <div className="panel-note danger">{info.state[0].toUpperCase() + info.state.slice(1)} in progress</div>}
      <div ref={scroller} className="panel-list">
        {files("Conflicts", conflicted, "conflicted")}
        {files("Staged", staged, "staged", { label: "Unstage all", run: () => void run("unstage", () => api.gitUnstageAll(ws.id)) })}
        {files("Changes", changed, "changed", { label: "Stage all", run: () => void run("stage", () => api.gitStageAll(ws.id)) })}
        {files("Untracked", untracked, "untracked", { label: "Stage all", run: () => void run("stage", () => api.gitStageAll(ws.id)) })}
        {/* Shown on a dirty tree even with no stashes, so Stash changes… is always reachable. */}
        {(stashes.length > 0 || dirty) && section("Stashes", stashes.length, stashes.map(stashRow), dirty ? { label: "Stash changes…", run: () => setNaming(true) } : undefined)}
        {!dirty && stashes.length === 0 && <div className="panel-empty">Working tree clean.</div>}
      </div>
      <div className="git-commit">
        <textarea
          placeholder={amend ? "Amended commit message" : "Commit message"}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); commit(); } }}
          rows={3}
        />
        <div className="git-commit-actions">
          <span className={`git-subject-count${subject > SUBJECT ? " over" : ""}`} title={`The first line's length; git's convention keeps a subject within ${SUBJECT} characters`}>
            {subject}/{SUBJECT}
          </span>
          <button onClick={commit} disabled={!ready}>
            {busy === "commit" ? "Committing…"
              : amend ? "Amend commit"
              : staged.length > 0 ? `Commit ${staged.length} ${staged.length === 1 ? "file" : "files"}`
              : "Commit"}
          </button>
          <MenuButton label="⋯" title="Other ways to commit">
            <button onClick={() => void toggleAmend(!amend)}>
              <span className="menu-check">{amend ? "✓" : ""}</span>
              <span className="menu-label">Amend last commit</span>
            </button>
          </MenuButton>
        </div>
      </div>
      {naming && (
        <Prompt
          title="Name the stash"
          onSubmit={(name) => { setNaming(false); void run("stash", () => api.gitStashPush(ws.id, name)); }}
          onClose={() => setNaming(false)}
        />
      )}
    </div>
  );
}
