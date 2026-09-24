import { useEffect, useState } from "react";
import * as editors from "../editors";
import { useLive } from "../live";
import type { Workspace } from "../types";

/** The headings of the active markdown document, the one at the cursor marked. */
export function Outline({ ws }: { ws: Workspace }) {
  const [, bump] = useState(0);
  // Out of sight it follows nothing: every keystroke in any document would
  // otherwise walk this one's headings again.
  const live = useLive();
  useEffect(() => (live ? editors.subscribe(() => bump((n) => n + 1)) : undefined), [live]);
  const activeId = editors.activeEditorId(ws);
  const doc = activeId ? editors.doc(activeId) : undefined;
  if (!doc) return <div className="tree-loading">Open a markdown file to see its outline.</div>;
  if (!doc.isMarkdown) return <div className="tree-loading">{doc.path} is not a markdown file.</div>;
  const headings = doc.outline();
  const trail = doc.headingTrail();
  const current = trail.length ? trail[trail.length - 1].from : -1;
  return (
    <nav className="tree outline">
      {headings.length === 0 && <div className="tree-loading">No headings.</div>}
      {headings.map((h) => (
        <div
          key={h.from}
          className={`tree-row${h.from === current ? " selected" : ""}`}
          style={{ paddingLeft: 8 + (h.level - 1) * 14 }}
          onClick={() => doc.jumpTo(h.from)}
          title={h.text}
        >
          <span className="tree-name">{h.text}</span>
        </div>
      ))}
    </nav>
  );
}
