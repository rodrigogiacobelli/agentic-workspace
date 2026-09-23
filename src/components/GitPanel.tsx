import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, events } from "../api";
import type { CommitDetail, DiffSpec, LogEntry, RepoInfo, Session, StatusEntry, Workspace } from "../types";
import { BranchList } from "./BranchList";
import { Icon } from "./icons";
import { MenuButton } from "./Menu";
import { report } from "./Switcher";
import { WorktreeList } from "./WorktreeList";

interface Props {
  ws: Workspace;
  session: Session;
  status: StatusEntry[];
  info: RepoInfo | null;
  refresh: () => void;
  onDiff: (path: string, diff: DiffSpec) => void;
  onOpenFile: (path: string) => void;
}

const PAGE = 50;

/** The height of the list of changes, kept while the panel is remounted. */
let changesHeight = 240;

export function GitPanel({ ws, session, status, info, refresh, onDiff, onOpenFile }: Props) {
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [branches, setBranches] = useState(false);
  const [worktrees, setWorktrees] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [height, setHeight] = useState(changesHeight);
  const panel = useRef<HTMLDivElement>(null);

  if (!info) return <div className="tree-loading loading">Loading…</div>;
  if (!info.isRepo) {
    return (
      <div className="git-empty">
        <p>{ws.name} is not inside a git repository.</p>
        <button onClick={() => api.gitInit(ws.id).then(refresh).catch(report)}>Initialise repository</button>
      </div>
    );
  }

  const staged = status.filter((s) => !s.untracked && !s.conflicted && s.index !== ".");
  const changed = status.filter((s) => !s.untracked && !s.conflicted && s.worktree !== ".");
  const untracked = status.filter((s) => s.untracked);
  const conflicted = status.filter((s) => s.conflicted);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); } catch (e) { report(e); } finally { setBusy(null); refresh(); }
  };

  const commit = () => run("commit", async () => {
    if (!message.trim()) throw new Error("Type a commit message first.");
    const out = await api.gitCommit(ws.id, message, amend);
    setMessage("");
    setAmend(false);
    if (out.trim()) window.dispatchEvent(new CustomEvent("app-notice", { detail: out.trim().split("\n")[0] }));
  });

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

  // The edge between the changes and the commit box: dragging it gives the
  // list more room and the history less, and nothing else moves.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const origin = e.clientY;
    const start = height;
    const room = panel.current?.getBoundingClientRect().height ?? 600;
    const move = (ev: MouseEvent) => {
      const next = Math.max(64, Math.min(room - 220, start + ev.clientY - origin));
      changesHeight = next;
      setHeight(next);
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const remote = (action: "fetch" | "pull" | "push") => run(action, async () => {
    const out = await api.gitRemote(ws.id, action, action === "push" && !info.upstream);
    window.dispatchEvent(new CustomEvent("app-notice", { detail: `${action}: ${out.trim() || "done"}` }));
  });

  const row = (entry: StatusEntry, section: "staged" | "changed" | "untracked" | "conflicted") => (
    <div
      key={`${section}:${entry.path}`}
      className="git-row"
      onClick={() => onDiff(entry.path, section === "staged" ? { kind: "staged", hash: null, untracked: false } : { kind: "worktree", hash: null, untracked: entry.untracked })}
      title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}
    >
      <span className={`git-letter s-${section === "staged" ? entry.index : entry.untracked ? "U" : entry.worktree}`}>
        {section === "staged" ? entry.index : entry.untracked ? "U" : section === "conflicted" ? "!" : entry.worktree}
      </span>
      <span className="git-path">{entry.path}</span>
      <span className="git-actions" onClick={(e) => e.stopPropagation()}>
        <button title="Open file" onClick={() => onOpenFile(entry.path)}>⤴</button>
        {section === "staged" ? (
          <button title="Unstage" onClick={() => void run("unstage", () => api.gitUnstage(ws.id, [entry.path]))}>−</button>
        ) : (
          <>
            {section !== "conflicted" && <button title="Discard" onClick={() => void discard(entry)}>↶</button>}
            <button title="Stage" onClick={() => void run("stage", () => api.gitStage(ws.id, [entry.path]))}>+</button>
          </>
        )}
      </span>
    </div>
  );

  const section = (title: string, entries: StatusEntry[], kind: "staged" | "changed" | "untracked" | "conflicted", action?: { label: string; run: () => void }) =>
    entries.length > 0 && (
      <div className="git-section">
        <div className="git-section-title">
          <span>{title} <span className="search-count">{entries.length}</span></span>
          {action && <button onClick={action.run}>{action.label}</button>}
        </div>
        {entries.map((e) => row(e, kind))}
      </div>
    );

  return (
    <div className="git-panel" ref={panel}>
      <div className="git-header">
        <button className="git-branch" onClick={() => setBranches(true)} title="Branches">
          {info.detached ? `detached @ ${info.branch ?? "?"}` : info.branch ?? "no branch"}
        </button>
        {info.state && <span className="git-state">{info.state}</span>}
        {(info.ahead > 0 || info.behind > 0) && <span className="git-ab">↑{info.ahead} ↓{info.behind}</span>}
        <button onClick={() => setWorktrees(true)} title="Worktrees">⑂</button>
        <button onClick={() => void remote("fetch")} title="Fetch" disabled={!!busy}>⟳</button>
        <button onClick={() => void remote("pull")} title="Pull" disabled={!!busy}>⇣</button>
        <button onClick={() => void remote("push")} title={info.upstream ? "Push" : "Push and set upstream"} disabled={!!busy}>⇡</button>
      </div>
      {info.isWorktree && (
        <div className="git-note">Worktree of {info.mainWorktree}</div>
      )}
      <div className="git-changes" style={{ height }}>
        {section("Conflicts", conflicted, "conflicted")}
        {section("Staged", staged, "staged", { label: "Unstage all", run: () => void run("unstage", () => api.gitUnstageAll(ws.id)) })}
        {section("Changes", changed, "changed", { label: "Stage all", run: () => void run("stage", () => api.gitStageAll(ws.id)) })}
        {section("Untracked", untracked, "untracked", { label: "Stage all", run: () => void run("stage", () => api.gitStageAll(ws.id)) })}
        {status.length === 0 && <div className="tree-loading">Working tree clean.</div>}
      </div>
      <div className="git-resize" onMouseDown={startResize} title="Drag to give the changes more or less room" />
      <div className="git-commit">
        <textarea
          placeholder={amend ? "Amended commit message" : "Commit message"}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) commit(); }}
          rows={3}
        />
        <div className="git-commit-actions">
          <button onClick={commit} disabled={!!busy || (!amend && staged.length === 0)}>
            {busy === "commit" ? "Committing…" : amend ? "Amend commit" : "Commit"}
          </button>
          <MenuButton label="⋯" title="Other ways to commit">
            <button onClick={() => void toggleAmend(!amend)}>
              <span className="menu-check">{amend ? "✓" : ""}</span>
              <span className="menu-label">Amend last commit</span>
            </button>
          </MenuButton>
        </div>
      </div>
      <History ws={ws} onDiff={onDiff} />
      {branches && <BranchList ws={ws} session={session} info={info} onClose={() => { setBranches(false); refresh(); }} />}
      {worktrees && <WorktreeList ws={ws} session={session} onClose={() => { setWorktrees(false); refresh(); }} />}
    </div>
  );
}

function History({ ws, onDiff }: { ws: Workspace; onDiff: (path: string, diff: DiffSpec) => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [done, setDone] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Map<string, CommitDetail>>(new Map());
  const loading = useRef(false);

  const load = useCallback(async (reset: boolean) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const skip = reset ? 0 : entries.length;
      const page = await api.gitLog(ws.id, skip, PAGE, filter || null);
      setEntries((prev) => (reset ? page : [...prev, ...page]));
      setDone(page.length < PAGE);
    } catch (e) {
      report(e);
    } finally {
      loading.current = false;
    }
  }, [ws.id, filter, entries.length]);

  useEffect(() => { void load(true); }, [ws.id, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const unlisten = events.onGitChanged((id) => { if (id === ws.id) void load(true); });
    return () => { void unlisten.then((u) => u()); };
  }, [ws.id, load]);

  // A commit opens in place, listing what it changed; each file opens its diff.
  const open = useCallback((hash: string) => {
    setExpanded(hash);
    if (!details.has(hash)) {
      api.gitShow(ws.id, hash)
        .then((d) => setDetails((m) => new Map(m).set(hash, d)))
        .catch((e) => { report(e); setExpanded((h) => (h === hash ? null : h)); });
    }
  }, [ws.id, details]);
  const toggle = (hash: string) => { if (expanded === hash) setExpanded(null); else open(hash); };

  useEffect(() => {
    const onShow = (e: Event) => {
      const hash = (e as CustomEvent<string>).detail;
      open(hash);
      window.setTimeout(() => document.querySelector(`[data-commit="${hash}"]`)?.scrollIntoView({ block: "nearest" }), 50);
    };
    window.addEventListener("show-commit", onShow);
    return () => window.removeEventListener("show-commit", onShow);
  }, [open]);

  const split = (path: string) => {
    const i = path.lastIndexOf("/");
    return i === -1 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
  };

  return (
    <div className="git-section git-history">
      <div className="git-section-title"><span>History</span></div>
      <input className="git-filter" placeholder="Filter by path" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div
        className="git-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!done && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) void load(false);
        }}
      >
        {entries.map((c) => {
          const isOpen = expanded === c.hash;
          const detail = details.get(c.hash);
          return (
            <div key={c.hash} data-commit={c.hash}>
              <div className={`git-commit-row${isOpen ? " selected" : ""}`} onClick={() => toggle(c.hash)} title={`${c.author} · ${c.date}\n\n${c.message}`}>
                <span className={`git-chevron${isOpen ? " open" : ""}`}>▸</span>
                <span className="git-subject">{c.subject}</span>
                <span className="git-meta">{c.author} · {c.date}</span>
                <button className="git-copy" title="Copy the commit hash" onClick={(e) => { e.stopPropagation(); void api.copyText(c.hash); }}><Icon name="copy" size={13} /></button>
              </div>
              {isOpen && (
                <div className="git-commit-files">
                  {!detail && <div className="tree-loading loading">Loading…</div>}
                  {detail?.files.map((f) => {
                    const { name, dir } = split(f.path);
                    return (
                      <div key={f.path} className="git-row" onClick={() => onDiff(f.path, { kind: "commit", hash: c.hash, untracked: false })} title={f.path}>
                        <span className={`git-letter s-${f.status}`}>{f.status}</span>
                        <span className="git-path">{name}</span>
                        {dir && <span className="git-dir">{dir}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {entries.length === 0 && <div className="tree-loading">No commits.</div>}
      </div>
    </div>
  );
}
