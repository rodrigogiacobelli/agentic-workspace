import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorState, Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, lineNumbers } from "@codemirror/view";
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { diff as diffMode } from "@codemirror/legacy-modes/mode/diff";
import { Chunk, MergeView } from "@codemirror/merge";
import { tags as t } from "@lezer/highlight";
import { api } from "../api";
import { keep, peek, useChanged, useKept } from "../live";
import { languageExtension, languageFor } from "../editor/languages";
import { report } from "../notice";
import * as repo from "../repo";
import type { EditorTab, Workspace } from "../types";

interface Props {
  ws: Workspace;
  /** A tab whose `diff` is set. */
  tab: EditorTab;
  onClose: () => void;
  /** Opens the file itself in the Editor. */
  onOpenInEditor: () => void;
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

type MarkKind = "add" | "del" | "mod";
interface Mark { top: number; height: number; kind: MarkKind }
interface Span { from: number; to: number; kind: MarkKind }

/** The changed lines of the new file, from the two versions of it. */
function sideSpans(old: string, now: string, length: number): Span[] {
  return Chunk.build(Text.of(old.split("\n")), Text.of(now.split("\n"))).map((c) => ({
    from: Math.min(c.fromB, length),
    to: Math.min(c.endB, length),
    kind: c.fromA === c.toA ? "add" : c.fromB === c.toB ? "del" : "mod",
  }));
}

/** The changed lines of a unified diff: its own `+` and `-` lines. */
function inlineSpans(doc: Text): Span[] {
  const spans: Span[] = [];
  let run: { from: number; to: number; add: boolean; del: boolean } | null = null;
  const flush = () => {
    if (run) spans.push({ from: run.from, to: run.to, kind: run.add && run.del ? "mod" : run.add ? "add" : "del" });
    run = null;
  };
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const add = line.text.startsWith("+") && !line.text.startsWith("+++");
    const del = line.text.startsWith("-") && !line.text.startsWith("---");
    if (!add && !del) { flush(); continue; }
    if (run) { run.to = line.to; run.add = run.add || add; run.del = run.del || del; }
    else run = { from: line.from, to: line.to, add, del };
  }
  flush();
  return spans;
}

/** Those spans as fractions of the scrollable height, which is what the
 * ruler is drawn in: the whole file is shown, so this is how a change is
 * found without reading it. */
function measure(view: EditorView, spans: Span[]): Mark[] {
  const total = view.contentHeight;
  if (!total) return [];
  return spans.map(({ from, to, kind }) => {
    const first = view.lineBlockAt(from);
    const last = view.lineBlockAt(Math.max(from, to));
    return { kind, top: first.top / total, height: Math.max((last.bottom - first.top) / total, 0.004) };
  });
}

/** The mode the last diff was read in; a new tab opens the same way. */
let lastMode: "inline" | "side" = "side";

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

/** Re-reads a diff when what it compares can have changed. */
function Follow({ workspaceId, files, onChange }: { workspaceId: string; files: boolean; onChange: () => void }) {
  useChanged(workspaceId, onChange, files);
  return null;
}

/** One diff of one path, as a tab. It follows the repository: a commit that
 * empties it says so and offers to close (FIX-09). What it last read, its
 * mode and its scroll are kept under the tab, so a diff rebuilt when its
 * workspace or its mode comes back paints as it was left and re-reads after. */
export function DiffView({ ws, tab, onClose, onOpenInEditor }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useKept<{ text: string; old: string; now: string } | null>(`${ws.id}:tab:${tab.id}:diff`, null);
  /** How the reader left it: the mode, and how far down. Scrolling writes the
   * offset without a render, and the view reads it back only when it is
   * built. The two modes measure differently, so a new mode starts at the top. */
  const [mode, setMode] = useKept(`${ws.id}:tab:${tab.id}:diff-mode`, lastMode);
  const topKey = `${ws.id}:tab:${tab.id}:diff-top`;
  const pick = (m: "inline" | "side") => {
    lastMode = m;
    if (m === mode) return;
    keep(topKey, 0);
    setMode(m);
  };
  const [marks, setMarks] = useState<Mark[]>([]);
  const [tick, setTick] = useState(0);
  const target = tab.diff!;
  const path = tab.path;

  const timer = useRef<number | null>(null);
  // A read already waiting takes later changes too; pushing it back would
  // starve it while an agent keeps writing.
  const reread = () => {
    if (timer.current) return;
    timer.current = window.setTimeout(() => { timer.current = null; setTick((n) => n + 1); }, 300);
  };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

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
      if (cancelled) return;
      // A workspace where agents write is never quiet, and every write asks
      // this diff to re-read itself. Rebuilding the view for a file that did
      // not change would throw the reader back to the top of the diff.
      setLoaded((before) => (before && before.text === text && before.old === old && before.now === now ? before : { text, old, now }));
    };
    load().catch(report);
    return () => { cancelled = true; };
  }, [ws.id, path, target.kind, target.hash, target.untracked, tick]);

  const empty = loaded !== null && loaded.text.trim() === "" && target.kind !== "commit";

  // Built in the layout phase, so a diff rebuilt from what it kept paints
  // with its content rather than a frame of nothing.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || !loaded || empty) return;
    el.replaceChildren();
    setMarks([]);
    // Side by side the merge view is the scroller; inline it is the editor's.
    const scroller = () => el.querySelector<HTMLElement>(".cm-mergeView, .cm-scroller");
    // Hidden behind a panel shown over the group, a scroller reads 0 and
    // takes no offset: it records nothing, and the offset waits for it to
    // have a height.
    const remember = () => {
      const s = scroller();
      if (s && s.clientHeight > 0) keep(topKey, s.scrollTop);
    };
    // Read before the new view exists: its first measure may scroll it, and
    // the listener would take that for the reader.
    const top = peek<number>(topKey) ?? 0;
    let waiting: ResizeObserver | null = null;
    const restore = (v: EditorView) => {
      const s = scroller();
      if (!s || !top) return;
      // Once the view has measured itself: an offset put back over the line
      // heights it guessed before it had a height lands on another line.
      const put = () => v.requestMeasure({ read: () => null, write: () => { s.scrollTop = top; } });
      if (s.clientHeight > 0) { put(); return; }
      waiting = new ResizeObserver(() => {
        if (s.clientHeight === 0) return;
        waiting?.disconnect();
        put();
      });
      waiting.observe(s);
    };
    el.addEventListener("scroll", remember, true);
    // The ruler follows the content height, which is an estimate until the
    // lines below the fold have been measured.
    let measured = 0;
    const paint = (v: EditorView, spans: Span[]) =>
      v.requestMeasure({
        key: "diff-ruler",
        read: () => (v.contentHeight === measured ? null : ((measured = v.contentHeight), measure(v, spans))),
        write: (m) => { if (m) setMarks(m); },
      });
    const follow = (spans: Span[]) => EditorView.updateListener.of((u) => { if (u.geometryChanged) paint(u.view, spans); });
    const lang = languageExtension(languageFor(path));
    const shared = [EditorState.readOnly.of(true), EditorView.editable.of(false), drawSelection(), lineNumbers(), theme, syntaxHighlighting(diffHighlight)];
    if (mode === "side") {
      const spans = sideSpans(loaded.old, loaded.now, loaded.now.length);
      const mv = new MergeView({
        a: { doc: loaded.old, extensions: [...shared, lang] },
        b: { doc: loaded.now, extensions: [...shared, lang, follow(spans)] },
        parent: el,
        highlightChanges: true,
        gutter: true,
      });
      paint(mv.b, spans);
      restore(mv.b);
      return () => { waiting?.disconnect(); el.removeEventListener("scroll", remember, true); mv.destroy(); };
    }
    const doc = loaded.text || "(no differences)";
    const spans = inlineSpans(Text.of(doc.split("\n")));
    const stageable = target.kind !== "commit";
    const unstage = target.kind === "staged";
    const hunks = stageable ? hunkPatches(loaded.text) : [];
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc,
        extensions: [
          ...shared,
          follow(spans),
          EditorView.lineWrapping,
          StreamLanguage.define(diffMode),
          EditorView.decorations.of((v) =>
            Decoration.set(
              hunks.map((h) => {
                const widget = new HunkWidget(unstage ? "Unstage hunk" : "Stage hunk", () => {
                  api.gitApplyHunk(ws.id, h.patch, unstage).then(() => repo.refresh(ws.id)).catch(report);
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
    paint(view, spans);
    restore(view);
    return () => { waiting?.disconnect(); el.removeEventListener("scroll", remember, true); view.destroy(); };
  }, [loaded, empty, mode, path, target.kind, ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const title =
    target.kind === "commit" ? `${target.hash?.slice(0, 7) ?? "commit"} — ${path}` : `${path} ${target.kind === "staged" ? "(staged)" : target.untracked ? "(untracked)" : "(changes)"}`;

  return (
    <div className="diff-view">
      {/* A commit named by its hash never changes; a staged diff changes with the index, a worktree diff with the files too. */}
      {!(target.kind === "commit" && target.hash) && <Follow workspaceId={ws.id} files={target.kind === "worktree"} onChange={reread} />}
      <div className="diff-header">
        <span className="diff-title" title={title}>{title}</span>
        <button className={mode === "inline" ? "active" : ""} onClick={() => pick("inline")}>Inline</button>
        <button className={mode === "side" ? "active" : ""} onClick={() => pick("side")}>Side by side</button>
        <button onClick={onOpenInEditor} title="Open the file in the Editor">Open in Editor ↗</button>
        <button onClick={onClose} title="Close">×</button>
      </div>
      {empty ? (
        <div className="diff-empty">
          <p>{path} has no {target.kind === "staged" ? "staged changes" : "changes against the working tree"} now.</p>
          <button onClick={onClose}>Close this tab</button>
        </div>
      ) : (
        <div className="diff-body">
          {!loaded && <div className="tree-loading">Loading…</div>}
          <div className="diff-host" ref={host} />
          {marks.length > 0 && (
            <div className="diff-ruler" aria-hidden="true">
              {marks.map((m, i) => (
                <div key={i} className={`diff-mark ${m.kind}`} style={{ top: `${m.top * 100}%`, height: `${m.height * 100}%` }} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
