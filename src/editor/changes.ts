// Where a file differs from git's index, as the lines that differ: one source
// of hunks for the gutter beside the text (GIT-14) and the marks over the
// scrollbar (SCR-09), and the diff, kinds and ruler geometry the diff tab
// shares. Nothing here shows what the index holds — only where the file
// departs from it: the gutter and the ruler carry no diff content.

import { EditorSelection, StateEffect, StateField, Text, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { Change, Chunk, diff } from "@codemirror/merge";

export type MarkKind = "add" | "del" | "mod";
/** A changed run of the new text, in its character offsets. */
export interface Span { from: number; to: number; kind: MarkKind }
/** A span placed on a ruler, in fractions of the height the ruler stands for. */
export interface Mark { top: number; height: number; kind: MarkKind }
/**
 * A run of changed lines, in the character offsets of the old text `a` and
 * the new text `b`. Each end sits at the start of the line after the run,
 * which may be one past the end of its text. A `Chunk` is one.
 */
export interface Hunk { fromA: number; toA: number; fromB: number; toB: number }

/**
 * Lines only the new text `b` has are added, lines only the old text `a` had
 * are deleted, and lines both have are changed. A text that ends in a line
 * break has an empty line after it, which git does not count: a hunk that
 * holds only that line on one side holds nothing there, so lines appended to
 * a file read as added, not as a change to its end.
 */
export function kindOf(h: Hunk, a: Text, b: Text): MarkKind {
  return h.fromA === h.toA || h.fromA === a.length ? "add" : h.fromB === h.toB || h.fromB === b.length ? "del" : "mod";
}

/**
 * A position on the last line of `b` a hunk covers. `toB` can point one past
 * the end of the document, so the line is found from the position before it;
 * and a hunk that reaches the empty line after a final line break stops short
 * of it, since git has no such line — a line break added to the last line
 * changes that line alone.
 */
export function endOf(h: Hunk, b: Text): number {
  if (h.fromB < b.length && h.toB > b.length && b.sliceString(b.length - 1) === "\n") return b.length - 1;
  return Math.max(h.fromB, h.toB - 1);
}

/**
 * The chunks as runs of changed lines. @codemirror/merge joins into one chunk
 * two changes that have a single empty line between them, and git does not:
 * the blank line between two edits is no edit, and the lines on either side
 * may be an added line and a changed one. So a chunk is split wherever a whole
 * unchanged line lies between its changes, each widened to its lines as the
 * chunk itself was.
 */
export function hunksOf(chunks: readonly Chunk[], a: Text, b: Text): Hunk[] {
  const out: Hunk[] = [];
  for (const c of chunks) {
    if (c.changes.length === 1) {
      out.push(c);
      continue;
    }
    let cur: Hunk | null = null;
    for (const ch of c.changes) {
      let fromA = c.fromA + ch.fromA, fromB = c.fromB + ch.fromB, toA = c.fromA + ch.toA, toB = c.fromB + ch.toB;
      const la = a.lineAt(fromA), lb = b.lineAt(fromB);
      // A change that starts at the end of a line on both sides starts on the next one.
      [fromA, fromB] = la.to === fromA && lb.to === fromB && fromA < a.length && fromB < b.length ? [fromA + 1, fromB + 1] : [la.from, lb.from];
      const ea = a.lineAt(toA), eb = b.lineAt(toB);
      if (ea.from !== toA || eb.from !== toB) [toA, toB] = [ea.to + 1, eb.to + 1];
      if (cur && (fromA <= cur.toA || fromB <= cur.toB)) {
        cur.toA = Math.max(cur.toA, toA);
        cur.toB = Math.max(cur.toB, toB);
      } else {
        out.push((cur = { fromA, toA: Math.max(fromA, toA), fromB, toB: Math.max(fromB, toB) }));
      }
    }
  }
  return out;
}

/** Those spans as fractions of `total`: the whole file is on the ruler, so
 * this is how a change is found without reading it. */
export function measure(view: EditorView, spans: readonly Span[], total: number): Mark[] {
  if (!total) return [];
  return spans.map(({ from, to, kind }) => {
    const first = view.lineBlockAt(from);
    const last = view.lineBlockAt(Math.max(from, to));
    return { kind, top: first.top / total, height: Math.max((last.bottom - first.top) / total, 0.004) };
  });
}

/** Above this, on either side, a file gets no marks: the first diff of it would hold up the view. */
export const MARKS_LIMIT = 2 * 1024 * 1024;
/**
 * An edited stretch is diffed by character, as @codemirror/merge's own views
 * diff, with a ceiling on time: past either, a diff falls back to a coarser one.
 */
const DIFF = { scanLimit: 500, timeout: 200 };
/** The ceiling on a whole file's diff by line, past which it settles for a coarser answer. */
const BY_LINE = { timeout: 100 };

/**
 * The chunks between two texts, diffed a line at a time as git diffs them.
 * Each distinct line, with its line break, is written as one character and
 * the two strings of them are diffed. Diffed by character, a blank line
 * between two edits can read as changed, and a file edited in many places
 * far apart soon passes the scan limit and reads as one change from its first
 * edit to its last. The empty line CodeMirror counts after a final line break
 * is no line to git and is left out, so a line break gained or lost at the
 * end changes the last line. A file with more distinct lines than there are
 * characters to write them with is diffed by character.
 */
export function buildChunks(a: Text, b: Text): readonly Chunk[] {
  const ids = new Map<string, number>();
  const encode = (t: Text): string | null => {
    const lines = t.line(t.lines).length ? t.lines : t.lines - 1;
    let s = "";
    let n = 0;
    for (const text of t.iterLines(1, lines + 1)) {
      const key = ++n < t.lines ? `${text}\n` : text;
      let id = ids.get(key);
      if (id === undefined) {
        // Every code unit but the surrogates: the diff never cuts between two that pair up.
        if (ids.size === 0xf800) return null;
        ids.set(key, (id = ids.size));
      }
      s += String.fromCharCode(id < 0xd800 ? id : id + 0x800);
    }
    return s;
  };
  const ea = encode(a);
  const eb = ea === null ? null : encode(b);
  if (ea === null || eb === null) return Chunk.build(a, b, DIFF);
  // Where the line counted from zero starts; past the last line, one past the end.
  const at = (t: Text, i: number) => (i < t.lines ? t.line(i + 1).from : t.length + 1);
  return diff(ea, eb, BY_LINE).map((c) => {
    const fromA = at(a, c.fromA), toA = at(a, c.toA), fromB = at(b, c.fromB), toB = at(b, c.toB);
    return new Chunk([new Change(0, toA - fromA, 0, toB - fromB)], fromA, toA, fromB, toB);
  });
}

/** The index's copy of the file; null when the index has none — untracked, no repository, binary. */
export const setBase = StateEffect.define<string | null>();
/** Diff the whole document against its base again, by line. */
const rediff = StateEffect.define<null>();
/** How long edits rest before the marks are brought back to git's answer. */
const SETTLE_MS = 400;

interface Changes { base: Text | null; chunks: readonly Chunk[]; hunks: readonly Hunk[] }

const NONE: Changes = { base: null, chunks: [], hunks: [] };

function byLine(base: Text, doc: Text): Changes {
  const chunks = buildChunks(base, doc);
  return { base, chunks, hunks: hunksOf(chunks, base, doc) };
}

/**
 * Once edits rest, the document is diffed by line again: a diff by character
 * drifts from git's lines — a blank line marked, a run of edits read as one
 * change — and would stay so until the index or the file moved.
 */
const settle = ViewPlugin.fromClass(class {
  private timer = 0;
  constructor(readonly view: EditorView) {}
  update(u: ViewUpdate) {
    if (!u.docChanged || !u.state.field(changeField).base) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.view.dispatch({ effects: rediff.of(null) }), SETTLE_MS);
  }
  destroy() {
    clearTimeout(this.timer);
  }
});

/**
 * The changed lines of the document against its base. A new base diffs the
 * whole file once, by line; an edit re-diffs only the stretch around it, by
 * character, so typing never waits on git or on a full diff (ADR-012), and the
 * whole file is diffed by line again once edits rest. The marks are drawn from
 * the hunks, the chunks split as git would split them.
 */
export const changeField = StateField.define<Changes>({
  create: () => NONE,
  update(value, tr) {
    let next: string | null | undefined;
    let again = false;
    for (const e of tr.effects) {
      if (e.is(setBase)) next = e.value;
      else if (e.is(rediff)) again = true;
    }
    const doc = tr.state.doc;
    if (next !== undefined) {
      if (next === null || next.length > MARKS_LIMIT || doc.length > MARKS_LIMIT) return NONE;
      // Split as CodeMirror splits the buffer, so a file with CRLF line ends
      // does not read as changed on every line.
      return byLine(Text.of(next.split(/\r\n?|\n/)), doc);
    }
    if (!value.base) return value;
    // Past the limit a whole diff would hold up the view, so edits stay diffed by character.
    if (again) return doc.length > MARKS_LIMIT ? value : byLine(value.base, doc);
    if (!tr.docChanged) return value;
    const chunks = Chunk.updateB(value.chunks, value.base, doc, tr.changes, DIFF);
    return { base: value.base, chunks, hunks: hunksOf(chunks, value.base, doc) };
  },
  provide: () => settle,
});

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: MarkKind) { super(); }
  eq(other: ChangeMarker) { return other.kind === this.kind; }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-change-mark ${this.kind}`;
    return el;
  }
}

const MARKERS: Record<MarkKind, ChangeMarker> = { add: new ChangeMarker("add"), mod: new ChangeMarker("mod"), del: new ChangeMarker("del") };

/** The last hunk that starts at or before `pos` in the document. */
function hunkAt(hunks: readonly Hunk[], pos: number): Hunk | undefined {
  let lo = 0;
  let hi = hunks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hunks[mid].fromB <= pos) lo = mid + 1;
    else hi = mid;
  }
  return hunks[lo - 1];
}

/**
 * A band beside each added or changed line, and a wedge on the top edge of
 * the line where lines were deleted (GIT-14). Asked once for every line drawn,
 * so each answer is a search of the hunks rather than a walk through them.
 */
export const changeGutter: Extension = gutter({
  class: "cm-change-gutter",
  lineMarker(view, line) {
    const { base, hunks } = view.state.field(changeField);
    const h = hunkAt(hunks, line.from);
    if (!h || !base) return null;
    const doc = view.state.doc;
    const kind = kindOf(h, base, doc);
    if (kind === "del") return h.fromB === line.from ? MARKERS.del : null;
    return line.from <= endOf(h, doc) ? MARKERS[kind] : null;
  },
  lineMarkerChange: (u) => u.startState.field(changeField) !== u.state.field(changeField),
});

/** Each hunk as the whole lines it covers. */
function spansOf({ base, hunks }: Changes, doc: Text): Span[] {
  return base ? hunks.map((h) => ({ from: doc.lineAt(h.fromB).from, to: doc.lineAt(endOf(h, doc)).to, kind: kindOf(h, base, doc) })) : [];
}

/**
 * The changes over the scrollbar's lane, in every view of a document
 * (SCR-09). The lane hangs on the editor's own element, beside the scroller
 * rather than in it, so it does not scroll away and it travels with the view
 * when a document is taken off screen and put back. A mark stands for its
 * lines' share of the document's height — not the scroller's, which counts
 * the empty room after the last line — and a click on one brings those lines
 * to the middle of the view without moving the cursor. `data-scroll-mark` is
 * what the app-drawn scrollbar looks for under a click on its track.
 */
export const changeRuler = ViewPlugin.fromClass(class {
  readonly dom: HTMLDivElement;
  private spans: Span[] = [];
  private drawn = "";

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-change-ruler";
    this.dom.setAttribute("aria-hidden", "true");
    // A press on a mark leaves the focus, and so the cursor, in the text.
    this.dom.addEventListener("mousedown", (e) => e.preventDefault());
    this.dom.addEventListener("click", (e) => {
      const mark = (e.target as HTMLElement).closest<HTMLElement>("[data-scroll-mark]");
      const span = mark ? this.spans[Number(mark.dataset.scrollMark)] : undefined;
      if (!span) return;
      const end = this.view.state.doc.length;
      // Head first, so a change taller than the view shows its start.
      const range = EditorSelection.range(Math.min(span.to, end), Math.min(span.from, end));
      this.view.dispatch({ effects: EditorView.scrollIntoView(range, { y: "center" }) });
    });
    view.dom.appendChild(this.dom);
    this.paint();
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.geometryChanged || u.startState.field(changeField) !== u.state.field(changeField)) this.paint();
  }

  // Heights below the fold are estimates until those lines are drawn, so the
  // marks are placed again whenever the geometry settles.
  private paint() {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const spans = spansOf(view.state.field(changeField), view.state.doc);
        const marks = measure(view, spans, view.lineBlockAt(view.state.doc.length).bottom);
        // Over the scroller alone: a search panel above or below it is no part of the file.
        return { spans, marks, top: view.scrollDOM.offsetTop, height: view.scrollDOM.offsetHeight };
      },
      write: ({ spans, marks, top, height }) => {
        this.spans = spans;
        const key = `${top} ${height} ${marks.map((m) => `${m.kind}${m.top}:${m.height}`).join(" ")}`;
        if (key === this.drawn) return;
        this.drawn = key;
        this.dom.style.top = `${top}px`;
        this.dom.style.height = `${height}px`;
        this.dom.replaceChildren(...marks.map((m, i) => {
          const el = document.createElement("div");
          el.className = `diff-mark ${m.kind}`;
          el.dataset.scrollMark = String(i);
          el.style.top = `${m.top * 100}%`;
          el.style.height = `${m.height * 100}%`;
          return el;
        }));
      },
    });
  }

  destroy() {
    this.dom.remove();
  }
});
