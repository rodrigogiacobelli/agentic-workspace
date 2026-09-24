import { useEffect, useRef, useState } from "react";
import { EditorState, Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, lineNumbers } from "@codemirror/view";
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { diff as diffMode } from "@codemirror/legacy-modes/mode/diff";
import { Chunk, MergeView } from "@codemirror/merge";
import { tags as t } from "@lezer/highlight";
import { api } from "../api";
import { useChanged } from "../live";
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

/** One diff of one path, as a tab. It follows the repository: a commit that
 * empties it says so and offers to close (FIX-09). */
export function DiffView({ ws, tab, onClose, onOpenInEditor }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"inline" | "side">(lastMode);
  const [loaded, setLoaded] = useState<{ text: string; old: string; now: string } | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [tick, setTick] = useState(0);
  /** What is on screen now, so a re-read that found nothing new is dropped
   * rather than rebuilding the view under the reader. */
  const shown = useRef<{ text: string; old: string; now: string } | null>(null);
  /** Where the reader was, kept across a rebuild they did not ask for. The
   * two modes measure differently, so an offset only restores into its own. */
  const at = useRef<{ mode: "inline" | "side"; top: number }>({ mode: lastMode, top: 0 });
  const target = tab.diff!;
  const path = tab.path;

  // A diff out of sight — another mode, another workspace — reads again once
  // it is back, rather than on every write an agent makes meanwhile.
  const timer = useRef<number | null>(null);
  // A read already waiting takes later changes too; pushing it back would
  // starve it while an agent keeps writing.
  useChanged(ws.id, () => {
    if (timer.current) return;
    timer.current = window.setTimeout(() => { timer.current = null; setTick((n) => n + 1); }, 300);
  }, true);
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
      const before = shown.current;
      if (before && before.text === text && before.old === old && before.now === now) return;
      shown.current = { text, old, now };
      setLoaded({ text, old, now });
    };
    load().catch(report);
    return () => { cancelled = true; };
  }, [ws.id, path, target.kind, target.hash, target.untracked, tick]);

  const empty = loaded !== null && loaded.text.trim() === "" && target.kind !== "commit";

  useEffect(() => {
    const el = host.current;
    if (!el || !loaded || empty) return;
    el.replaceChildren();
    setMarks([]);
    // Side by side the merge view is the scroller; inline it is the editor's.
    const scroller = () => el.querySelector<HTMLElement>(".cm-mergeView, .cm-scroller");
    const remember = () => {
      const s = scroller();
      if (s) at.current = { mode, top: s.scrollTop };
    };
    const restore = () =>
      requestAnimationFrame(() => {
        const s = scroller();
        if (s && at.current.mode === mode && at.current.top) s.scrollTop = at.current.top;
      });
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
      restore();
      return () => { el.removeEventListener("scroll", remember, true); mv.destroy(); };
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
    restore();
    return () => { el.removeEventListener("scroll", remember, true); view.destroy(); };
  }, [loaded, empty, mode, path, target.kind, ws.id]);

  const title =
    target.kind === "commit" ? `${target.hash?.slice(0, 7) ?? "commit"} — ${path}` : `${path} ${target.kind === "staged" ? "(staged)" : target.untracked ? "(untracked)" : "(changes)"}`;

  return (
    <div className="diff-view">
      <div className="diff-header">
        <span className="diff-title" title={title}>{title}</span>
        <button className={mode === "inline" ? "active" : ""} onClick={() => { lastMode = "inline"; setMode("inline"); }}>Inline</button>
        <button className={mode === "side" ? "active" : ""} onClick={() => { lastMode = "side"; setMode("side"); }}>Side by side</button>
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
