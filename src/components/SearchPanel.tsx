import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { SearchHit, Workspace } from "../types";
import { report } from "./Switcher";

interface Props {
  ws: Workspace;
  onOpen: (path: string, line: number, column: number) => void;
}

/** Project-wide text search, grouped by file. */
export function SearchPanel({ ws, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const run = () => {
    const q = query;
    if (!q) { setHits([]); setSearched(""); return; }
    api.searchProject(ws.id, q, includeIgnored)
      .then((h) => { setHits(h); setSearched(q); })
      .catch(report);
  };
  useEffect(run, [includeIgnored]); // eslint-disable-line react-hooks/exhaustive-deps

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
          onKeyDown={(e) => { if (e.key === "Enter") run(); }}
        />
        <label title="Search ignored paths too">
          <input type="checkbox" checked={includeIgnored} onChange={(e) => setIncludeIgnored(e.target.checked)} /> ignored
        </label>
      </div>
      <div className="search-results">
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
