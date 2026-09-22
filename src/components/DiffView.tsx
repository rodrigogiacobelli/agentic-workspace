import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, lineNumbers } from "@codemirror/view";
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { diff as diffMode } from "@codemirror/legacy-modes/mode/diff";
import { MergeView } from "@codemirror/merge";
import { tags as t } from "@lezer/highlight";
import { api, events } from "../api";
import { languageExtension, languageFor } from "../editor/languages";
import type { EditorTab, Workspace } from "../types";
import { report } from "./Switcher";

interface Props {
  ws: Workspace;
  /** A tab whose `diff` is set. */
  tab: EditorTab;
  onClose: () => void;
  onChanged: () => void;
}

const diffHighlight = HighlightStyle.define([
  { tag: t.inserted, color: "var(--syn-string)" },
  { tag: t.deleted, color: "var(--danger)" },
  { tag: t.meta, color: "var(--syn-meta)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "var(--editor-size)", lineHeight: "1.5" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-faint)", borderRight: "1px solid var(--border)" },
  ".cm-mergeView, .cm-mergeViewEditors": { height: "100%" },
  ".cm-mergeViewEditor": { overflow: "auto" },
  ".cm-changedLine": { backgroundColor: "rgba(120, 160, 255, 0.10)" },
  ".cm-deletedChunk": { backgroundColor: "rgba(255, 90, 90, 0.10)" },
  ".cm-changedText": { background: "rgba(120, 200, 120, 0.25)" },
  ".cm-deletedText": { background: "rgba(255, 90, 90, 0.25)" },
  ".cm-selectionLayer": { zIndex: "1 !important", pointerEvents: "none" },
  ".cm-selectionBackground": { backgroundColor: "var(--selection) !important", opacity: "0.55" },
  "&.cm-focused .cm-selectionBackground": { opacity: "1" },
});

/** A button on a hunk header that stages or unstages that hunk alone. */
class HunkWidget extends WidgetType {
  constructor(readonly label: string, readonly onClick: () => void) { super(); }
  toDOM() {
    const el = document.createElement("button");
    el.className = "hunk-action";
    el.textContent = this.label;
    el.onmousedown = (e) => e.preventDefault();
    el.onclick = (e) => { e.preventDefault(); this.onClick(); };
    return el;
  }
  eq(other: HunkWidget) { return other.label === this.label; }
  ignoreEvent() { return true; }
}

/** Splits a unified diff into its header and one patch per hunk. */
function hunkPatches(text: string): { line: number; patch: string }[] {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  if (first === -1) return [];
  const header = lines.slice(0, first).join("\n");
  const out: { line: number; patch: string }[] = [];
  let i = first;
  while (i < lines.length) {
    if (!lines[i].startsWith("@@")) { i++; continue; }
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith("@@")) j++;
    const hunk = lines.slice(i, j).filter((l, k) => !(k === j - i - 1 && l === "")).join("\n");
    out.push({ line: i + 1, patch: `${header}\n${hunk}\n` });
    i = j;
  }
  return out;
}

/** One diff of one path, as a tab. It follows the repository: a commit that
 * empties it says so and offers to close (FIX-09). */
export function DiffView({ ws, tab, onClose, onChanged }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"inline" | "side">("inline");
  const [loaded, setLoaded] = useState<{ text: string; old: string; now: string } | null>(null);
  const [tick, setTick] = useState(0);
  const target = tab.diff!;
  const path = tab.path;

  useEffect(() => {
    let timer: number | null = null;
    const schedule = (id: string) => {
      if (id !== ws.id) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((n) => n + 1), 300);
    };
    const a = events.onGitChanged(schedule);
    const b = events.onDirChanged((c) => schedule(c.workspaceId));
    return () => { void a.then((u) => u()); void b.then((u) => u()); if (timer) window.clearTimeout(timer); };
  }, [ws.id]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let text = "";
      let old = "";
      let now = "";
      if (target.kind === "worktree") {
        text = await api.gitDiff(ws.id, path, false, target.untracked);
        old = target.untracked ? "" : await api.gitShowFile(ws.id, ":", path);
        now = await api.readFile(ws.id, path).catch(() => "");
      } else if (target.kind === "staged") {
        text = await api.gitDiff(ws.id, path, true, false);
        old = await api.gitShowFile(ws.id, "HEAD", path);
        now = await api.gitShowFile(ws.id, ":", path);
      } else {
        const hash = target.hash ?? "HEAD";
        text = await api.gitCommitFileDiff(ws.id, hash, path);
        old = await api.gitShowFile(ws.id, `${hash}^`, path);
        now = await api.gitShowFile(ws.id, hash, path);
      }
      if (!cancelled) setLoaded({ text, old, now });
    };
    load().catch(report);
    return () => { cancelled = true; };
  }, [ws.id, path, target.kind, target.hash, target.untracked, tick]);

  const empty = loaded !== null && loaded.text.trim() === "" && target.kind !== "commit";

  useEffect(() => {
    const el = host.current;
    if (!el || !loaded || empty) return;
    el.replaceChildren();
    const lang = languageExtension(languageFor(path));
    const shared = [EditorState.readOnly.of(true), EditorView.editable.of(false), drawSelection(), lineNumbers(), theme, syntaxHighlighting(diffHighlight)];
    if (mode === "side") {
      const mv = new MergeView({
        a: { doc: loaded.old, extensions: [...shared, lang] },
        b: { doc: loaded.now, extensions: [...shared, lang] },
        parent: el,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
      });
      return () => mv.destroy();
    }
    const stageable = target.kind !== "commit";
    const unstage = target.kind === "staged";
    const hunks = stageable ? hunkPatches(loaded.text) : [];
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: loaded.text || "(no differences)",
        extensions: [
          ...shared,
          EditorView.lineWrapping,
          StreamLanguage.define(diffMode),
          EditorView.decorations.of((v) =>
            Decoration.set(
              hunks.map((h) => {
                const widget = new HunkWidget(unstage ? "Unstage hunk" : "Stage hunk", () => {
                  api.gitApplyHunk(ws.id, h.patch, unstage).then(onChanged).catch(report);
                });
                const pos = v.state.doc.line(Math.min(h.line, v.state.doc.lines)).from;
                return Decoration.widget({ widget, side: -1 }).range(pos);
              }),
              true,
            ),
          ),
        ],
      }),
    });
    return () => view.destroy();
  }, [loaded, empty, mode, path, target.kind, ws.id, onChanged]);

  const title =
    target.kind === "commit" ? `${target.hash?.slice(0, 7) ?? "commit"} — ${path}` : `${path} ${target.kind === "staged" ? "(staged)" : target.untracked ? "(untracked)" : "(changes)"}`;

  return (
    <div className="diff-view">
      <div className="diff-header">
        <span className="diff-title" title={title}>{title}</span>
        <button className={mode === "inline" ? "active" : ""} onClick={() => setMode("inline")}>Inline</button>
        <button className={mode === "side" ? "active" : ""} onClick={() => setMode("side")}>Side by side</button>
        <button onClick={onClose} title="Close">×</button>
      </div>
      {empty ? (
        <div className="diff-empty">
          <p>{path} has no {target.kind === "staged" ? "staged changes" : "changes against the working tree"} now.</p>
          <button onClick={onClose}>Close this tab</button>
        </div>
      ) : (
        <div className="diff-host" ref={host}>{!loaded && <div className="tree-loading">Loading…</div>}</div>
      )}
    </div>
  );
}
