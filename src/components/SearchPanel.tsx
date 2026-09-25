import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import { useKept, useKeptScroll, useLive } from "../live";
import type { SearchHit, Workspace } from "../types";
import { report } from "./Switcher";

interface Props {
  ws: Workspace;
  onOpen: (path: string, line: number, column: number) => void;
}

/**
 * Workspaces whose Search was asked for the keyboard, by its tab or its
 * hotkey, and has not taken it yet. Heard here rather than in the panel: the
 * asking comes first when it is what brings the panel into being.
 */
const wanted = new Set<string>();
window.addEventListener("panel-focus", (e) => {
  const { workspaceId, id } = (e as CustomEvent<{ workspaceId: string; id: string }>).detail;
  if (id === "search") wanted.add(workspaceId);
});

interface Result {
  hits: SearchHit[];
  /** The query the hits answer. */
  searched: string;
}

const NONE: Result = { hits: [], searched: "" };

/**
 * Project-wide text search, grouped by file. The query, the option and the
 * hits are kept, so the panel rebuilt when it comes back shows the last
 * search as it was left, without running it again.
 */
export function SearchPanel({ ws, onOpen }: Props) {
  const [query, setQuery] = useKept(`${ws.id}:search:query`, "");
  const [includeIgnored, setIncludeIgnored] = useKept(`${ws.id}:search:ignored`, false);
  const [{ hits, searched }, setResult] = useKept<Result>(`${ws.id}:search:result`, NONE);
  const scroller = useKeptScroll<HTMLDivElement>(`${ws.id}:search:scroll`);
  const input = useRef<HTMLInputElement>(null);
  // The field takes the keyboard when its tab or its hotkey asks for it —
  // not when a mode or a workspace comes back and rebuilds the panel, which
  // returns the keyboard to the document it left. A hotkey that also
  // switches mode lands before the mode is on screen, so the focus waits for it.
  const live = useLive();
  const liveRef = useRef(live);
  liveRef.current = live;
  const take = useCallback(() => {
    if (!liveRef.current || !wanted.has(ws.id)) return;
    wanted.delete(ws.id);
    input.current?.focus();
  }, [ws.id]);
  useEffect(() => {
    window.addEventListener("panel-focus", take);
    return () => window.removeEventListener("panel-focus", take);
  }, [take]);
  useEffect(take);

  const run = (q: string, ignored: boolean) => {
    if (!q) { setResult(NONE); return; }
    api.searchProject(ws.id, q, ignored)
      .then((h) => setResult({ hits: h, searched: q }))
      .catch(report);
  };

  const groups = new Map<string, SearchHit[]>();
  for (const h of hits) groups.set(h.path, [...(groups.get(h.path) ?? []), h]);

  return (
    <div className="search-panel">
      <div className="search-controls">
        <input
          ref={input}
          placeholder="Search in project"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(query, includeIgnored); }}
        />
        <label title="Search ignored paths too">
          <input type="checkbox" checked={includeIgnored} onChange={(e) => { setIncludeIgnored(e.target.checked); run(query, e.target.checked); }} /> ignored
        </label>
      </div>
      <div ref={scroller} className="search-results">
        {searched && hits.length === 0 && <div className="tree-loading">No results for “{searched}”</div>}
        {[...groups.entries()].map(([path, fileHits]) => (
          <div key={path} className="search-file">
            <div className="search-file-name" title={path}>{path} <span className="search-count">{fileHits.length}</span></div>
            {fileHits.map((h, i) => (
              <div key={i} className="search-hit" onClick={() => onOpen(h.path, h.line, h.column)} title={`${h.path}:${h.line}:${h.column + 1}`}>
                <span className="search-line">{h.line}</span>
                <span className="search-text">{h.text.trimStart()}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
