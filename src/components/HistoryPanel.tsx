import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { api } from "../api";
import { keep, useChanged, useKept, useKeptScroll, useLive } from "../live";
import { report } from "../notice";
import * as repo from "../repo";
import type { CommitDetail, DiffSpec, LogEntry, Workspace } from "../types";
import { PathLabel } from "./CommitPanel";
import { Icon } from "./icons";

interface Props {
  ws: Workspace;
  onDiff: (path: string, diff: DiffSpec) => void;
}

const PAGE = 50;

/** Where a commit asked for by name waits for the workspace's History to open it. */
const pendingKey = (workspaceId: string) => `${workspaceId}:history:show`;

/**
 * Opens a commit in the workspace's History. A History on screen, or held
 * behind another tab, opens it at once; otherwise it waits under a kept key
 * and the History built next opens it.
 */
export function showCommit(workspaceId: string, hash: string): void {
  keep(pendingKey(workspaceId), hash);
  window.dispatchEvent(new CustomEvent("show-commit", { detail: { workspaceId, hash } }));
}

// The graph's geometry. ROW_H is `.history-row`'s height in styles.css: each
// row draws its own slice of the graph, and the lanes only meet from one row
// to the next while the two agree.
const ROW_H = 22;
const LANE_W = 10;
/** The centre of lane 0, and the margin left past the last lane. */
const PAD = 8;
/** Lanes past this are clipped, so a wild history cannot eat the panel. */
const MAX_LANES = 10;
const COLOURS = ["var(--accent)", "#86efac", "#e0b35a", "#c4b5fd"];

const colour = (lane: number) => COLOURS[lane % COLOURS.length];
const laneX = (lane: number) => PAD + lane * LANE_W;

/** One commit's slice of the graph. A lane holds the hash it is waiting for. */
interface GraphRow {
  lane: number;
  /** Lanes arriving from above that end at this commit: its children's. */
  incoming: number[];
  /** What each lane carries into the row from above. */
  above: (string | null)[];
  /** What each lane carries out of the row below. */
  below: (string | null)[];
  /** The lane each parent continues in, first parent first. */
  parents: number[];
}

/**
 * Lanes for a list in which every commit comes before its parents. A commit
 * takes the first lane waiting for it, and every other lane waiting for it
 * merges in there. Its first parent keeps its lane; each other parent joins
 * the lane already waiting for it or takes the first free one. `width` is the
 * most lanes ever open at once.
 */
function graphLayout(entries: LogEntry[]): { rows: GraphRow[]; width: number } {
  const lanes: (string | null)[] = [];
  const free = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.push(null) - 1 : i;
  };
  const rows = entries.map((c) => {
    const incoming = lanes.flatMap((h, i) => (h === c.hash ? [i] : []));
    const lane = incoming.length > 0 ? incoming[0] : free();
    for (const i of incoming) lanes[i] = null;
    const above = lanes.slice();
    if (incoming.length > 0) above[lane] = c.hash;
    const parents = c.parents.map((p, i) => {
      const at = lanes.indexOf(p);
      const to = i === 0 ? lane : at !== -1 ? at : free();
      lanes[to] = p;
      return to;
    });
    return { lane, incoming, above, below: lanes.slice(), parents };
  });
  return { rows, width: lanes.length };
}

/** A straight segment, or an S-curve between two lanes. */
function edge(x1: number, y1: number, x2: number, y2: number): string {
  const m = (y1 + y2) / 2;
  return x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${m} ${x2} ${m} ${x2} ${y2}`;
}

/** A row's graph: the lanes passing it, the children merging in, the node, and the links down to its parents. */
function Rail({ row, merge, width }: { row: GraphRow; merge: boolean; width: number }) {
  const mid = ROW_H / 2;
  const x = laneX(row.lane);
  const paths: { d: string; lane: number }[] = [];
  row.above.forEach((h, l) => { if (h && l !== row.lane) paths.push({ d: edge(laneX(l), 0, laneX(l), ROW_H), lane: l }); });
  if (row.above[row.lane]) paths.push({ d: edge(x, 0, x, mid), lane: row.lane });
  for (const l of row.incoming) if (l !== row.lane) paths.push({ d: edge(laneX(l), 0, x, mid), lane: l });
  for (const l of row.parents) paths.push({ d: edge(x, mid, laneX(l), ROW_H), lane: l });
  return (
    <svg className="history-rail" width={width} height={ROW_H} aria-hidden="true">
      {paths.map((p, i) => <path key={i} d={p.d} style={{ stroke: colour(p.lane) }} />)}
      {/* A merge commit is drawn hollow. */}
      <circle cx={x} cy={mid} r={merge ? 3.5 : 3} style={{ fill: merge ? "var(--bg)" : colour(row.lane), stroke: colour(row.lane) }} />
    </svg>
  );
}

/** The lanes leaving an open commit, carried straight down past its file list so the graph does not break. */
function Continuation({ row, width }: { row: GraphRow; width: number }) {
  return (
    <svg className="history-rail" width={width} viewBox={`0 0 ${width} 1`} preserveAspectRatio="none" aria-hidden="true">
      {row.below.map((h, l) => h && <path key={l} d={`M${laneX(l)} 0V1`} vectorEffect="non-scaling-stroke" style={{ stroke: colour(l) }} />)}
    </svg>
  );
}

const AGES: [number, string][] = [[31536000, "y"], [2592000, "mo"], [604800, "w"], [86400, "d"], [3600, "h"], [60, "m"]];

/** A commit's age in the column's compact form: "now", "5 m", "4 h", "3 d", "2 w", "7 mo", "2 y". */
function age(timestamp: number): string {
  if (!timestamp) return "";
  const s = Date.now() / 1000 - timestamp;
  const unit = AGES.find(([n]) => s >= n);
  return unit ? `${Math.floor(s / unit[0])} ${unit[1]}` : "now";
}

/** One colour per author, so a glance tells an agent's commits from a person's. */
function authorColour(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return COLOURS[Math.abs(h) % COLOURS.length];
}

/** A page of rows and the query that read it; a new filter keeps the old rows on screen until its own land. */
interface Rows {
  /** The filter and branch scope the rows answer, as `query` spells them. */
  query: string;
  entries: LogEntry[];
  /** The last page came back short: there is nothing further to ask for. */
  done: boolean;
}

const NO_ROWS: Rows = { query: "", entries: [], done: false };

/** The commit open in place, and its files once `git show` answers. */
interface Open {
  hash: string;
  detail: CommitDetail | null;
}

/**
 * The commit log as a graph, a page at a time; a commit opens in place to
 * list its files. Its rows, filter, open commit and scroll are kept, so a
 * History rebuilt when its workspace or mode comes back paints as it was
 * left and reads the log again behind it.
 */
export function HistoryPanel({ ws, onDiff }: Props) {
  const { info } = repo.useRepo(ws.id);
  const isRepo = info?.isRepo === true;
  const [filter, setFilter] = useKept(`${ws.id}:history:filter`, "");
  const [all, setAll] = useKept(`${ws.id}:history:all`, false);
  const query = JSON.stringify([filter, all]);
  const [rows, setRows] = useKept<Rows>(`${ws.id}:history:rows`, NO_ROWS);
  const { entries, done } = rows;
  /** Rows loaded for the query on screen, which a re-read asks for again. */
  const loaded = rows.query === query ? entries.length : 0;
  const [open, setOpen] = useKept<Open | null>(`${ws.id}:history:open`, null);
  const [pending, setPending] = useKept<string | null>(pendingKey(ws.id), null);
  const list = useRef<HTMLDivElement | null>(null);
  const keptScroll = useKeptScroll<HTMLDivElement>(`${ws.id}:history:scroll`, entries.length > 0);
  const listRef = useCallback((el: HTMLDivElement | null) => {
    list.current = el;
    const undo = keptScroll(el);
    return () => { list.current = null; undo?.(); };
  }, [keptScroll]);
  /** The last read asked for; one that lands after a newer one was asked for is dropped. */
  const latest = useRef(0);
  const reading = useRef(false);

  const read = useCallback(async (skip: number, limit: number) => {
    const id = ++latest.current;
    reading.current = true;
    try {
      const page = await api.gitLog(ws.id, skip, limit, filter || null, all);
      if (id !== latest.current) return;
      const last = page.length < limit;
      setRows((prev) => {
        const ours = prev.query === query;
        // A re-read that found what is listed already keeps the rows, and nothing is drawn again.
        if (ours && prev.done === last && prev.entries.length === skip + page.length
          && JSON.stringify(prev.entries.slice(skip)) === JSON.stringify(page)) return prev;
        return { query, entries: [...(ours ? prev.entries.slice(0, skip) : []), ...page], done: last };
      });
    } catch (e) {
      if (id !== latest.current) return;
      report(e);
      // Stop paging: every scroll would otherwise ask again and fail again.
      setRows((prev) => ({ ...prev, done: true }));
    } finally {
      if (id === latest.current) reading.current = false;
    }
  }, [ws.id, filter, all, query, setRows]);

  // Every row already loaded is read again, not only the first page, so the
  // list keeps its length and the scroll position holds (the spirit of DIF-12)
  // — on a change, and when the list is rebuilt from what it kept.
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  useEffect(() => { if (isRepo) void read(0, Math.max(PAGE, loadedRef.current)); }, [read, isRepo]);
  useChanged(ws.id, () => { if (isRepo) void read(0, Math.max(PAGE, loaded)); });

  // A page that does not fill the list gives it nothing to scroll, and the
  // scroll is what asks for the next one; so an unfilled list asks now.
  // Only on screen: a hidden list measures zero, which would read as always
  // at the bottom and page through the whole history. Only for the query on
  // screen: the rows of the last one, still shown while the new one reads,
  // are no place to page from.
  const live = useLive();
  const more = useCallback(() => {
    const el = list.current;
    if (!live || !el || el.clientHeight === 0 || done || reading.current || loaded === 0) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) void read(loaded, PAGE);
  }, [live, done, loaded, read]);
  useEffect(more, [more]);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const observer = new ResizeObserver(() => more());
    observer.observe(el);
    return () => observer.disconnect();
  }, [more, isRepo]);

  const openCommit = useCallback((hash: string) => {
    setOpen({ hash, detail: null });
    api.gitShow(ws.id, hash)
      .then((detail) => setOpen((o) => (o?.hash === hash ? { hash, detail } : o)))
      .catch((e) => { report(e); setOpen((o) => (o?.hash === hash ? null : o)); });
  }, [ws.id, setOpen]);
  const toggle = (hash: string) => { if (open?.hash === hash) setOpen(null); else openCommit(hash); };

  // Blame asks for a commit by name (`showCommit`): at once when this History
  // is mounted, or on its first render when it is built for the asking.
  /** A commit asked for by name, scrolled to once the rows are drawn. */
  const reveal = useRef<string | null>(null);
  const show = useCallback((hash: string) => {
    setPending(null);
    reveal.current = hash;
    openCommit(hash);
  }, [setPending, openCommit]);
  useEffect(() => { if (pending) show(pending); }, [pending, show]);
  useEffect(() => {
    const onShow = (e: Event) => {
      const { workspaceId, hash } = (e as CustomEvent<{ workspaceId: string; hash: string }>).detail;
      if (workspaceId === ws.id) show(hash);
    };
    window.addEventListener("show-commit", onShow);
    return () => window.removeEventListener("show-commit", onShow);
  }, [ws.id, show]);
  useEffect(() => {
    const hash = reveal.current;
    if (!hash || entries.length === 0) return;
    reveal.current = null;
    list.current?.querySelector(`[data-commit="${hash}"]`)?.scrollIntoView({ block: "nearest" });
  });

  // Recomputed over the whole list, so a page appended below carries on the lanes above it.
  const graph = useMemo(() => graphLayout(entries), [entries]);
  const graphWidth = 2 * PAD + (Math.min(Math.max(graph.width, 1), MAX_LANES) - 1) * LANE_W;

  if (!info) return <div className="panel"><div className="tree-loading loading">Loading…</div></div>;
  if (!info.isRepo) return <div className="panel"><div className="panel-empty">{ws.name} is not inside a git repository.</div></div>;

  return (
    <div className="panel history" style={{ "--graph-w": `${graphWidth}px` } as CSSProperties}>
      <div className="panel-bar">
        <input placeholder="Filter by path" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className={all ? "on" : ""} aria-pressed={all} onClick={() => setAll(!all)} title="Every branch's commits, not only those HEAD reaches">
          All branches
        </button>
      </div>
      <div className="history-head" aria-hidden="true">
        <span />
        <span>Commit</span>
        <span className="history-author">Author</span>
        <span className="history-when">When</span>
        <span className="history-hash">Hash</span>
      </div>
      <div ref={listRef} className="panel-list" onScroll={more}>
        {graph.rows.map((row, i) => {
          const c = entries[i];
          const isOpen = open?.hash === c.hash;
          const detail = isOpen ? open.detail : null;
          return (
            <div key={c.hash} data-commit={c.hash}>
              <div className={`history-row${isOpen ? " selected" : ""}`} onClick={() => toggle(c.hash)} title={`${c.author} · ${c.date}\n\n${c.message}`}>
                <Rail row={row} merge={c.parents.length > 1} width={graphWidth} />
                <span className="history-subject">
                  {c.refs.map((r) => <span key={`${r.kind}:${r.name}`} className={`ref ${r.kind}`}>{r.name}</span>)}
                  <span className="history-text">{c.subject}</span>
                </span>
                <span className="history-author">
                  <span className="history-avatar" style={{ background: authorColour(c.author) }}>{c.author.trim().charAt(0).toUpperCase() || "?"}</span>
                  {c.author}
                </span>
                <span className="history-when">{age(c.timestamp)}</span>
                <span className="history-hash">{c.short}</span>
                <span className="git-actions" onClick={(e) => e.stopPropagation()}>
                  <button title="Copy the commit hash" onClick={() => void api.copyText(c.hash).catch(report)}><Icon name="copy" size={13} /></button>
                </span>
              </div>
              {isOpen && (
                <div className="history-files">
                  <Continuation row={row} width={graphWidth} />
                  {!detail && <div className="tree-loading loading">Loading…</div>}
                  {detail?.files.map((f) => (
                    <div key={f.path} className="git-row" onClick={() => onDiff(f.path, { kind: "commit", hash: c.hash, untracked: false })} title={f.path}>
                      <span className={`git-letter s-${f.status}`}>{f.status}</span>
                      <PathLabel path={f.path} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {entries.length === 0 && (done ? <div className="panel-empty">No commits.</div> : <div className="tree-loading loading">Loading…</div>)}
      </div>
    </div>
  );
}
