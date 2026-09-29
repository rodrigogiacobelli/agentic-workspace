// Where the caret stands in the rendered view and what an edit there writes
// (ADR-011). The rendered view hides Markdown's syntax, draws some of it as a
// glyph, and draws images, citations and rules as single objects. This module
// works out, from the document's parse alone, what is hidden, where the caret
// may stand, where typed text goes, and which bytes each edit changes, so that
// every edit splices only the construct it touches (ED-07). `preview.ts` draws
// what this module describes and binds its commands; nothing here touches the
// page.

import { language, syntaxTree } from "@codemirror/language";
import {
  type ChangeDesc, type ChangeSet, type ChangeSpec, CharCategory, EditorSelection, type EditorState, findClusterBreak, type Line, type SelectionRange, type Text, type Transaction,
} from "@codemirror/state";
import type { Parser, SyntaxNode, Tree } from "@lezer/common";

/**
 * Syntax the caret never stands inside, and crosses without a key press: a
 * mark the rendered view hides, a bullet or task box drawn in place of its
 * mark, a list number or indentation left as it is.
 */
export interface Piece {
  from: number;
  to: number;
  /** Text typed at this piece goes after it — a block's marks, a link's end — rather than before it. */
  after: boolean;
  /** Block syntax at the start of a line: a heading's, quote's or list item's marks, a task box, indentation. */
  block: boolean;
  /** How the rendered view draws it. A bullet or task box stands for `from` to `mark`; the spaces after it stay. */
  draw: "hide" | "keep" | "bullet" | "task";
  mark?: number;
  /** A bullet's nesting depth. */
  level?: number;
  /** Whether a task box is ticked. */
  checked?: boolean;
  /** A hidden line break (`Layout.merges`). */
  merge?: boolean;
  /** A backslash bound to the character or line break after it, which nothing may be typed between. */
  glue?: boolean;
  /** An inline construct's opening syntax, as against its closing syntax. */
  open?: boolean;
  /** A table's pipe between two cells, with the spaces beside it: the caret stands on either side, as at a line break. */
  cell?: boolean;
}

/** An image, a citation or a rule: one object, which one arrow press steps over and one deletion takes whole. */
export interface Obj { from: number; to: number; name: string }

/** Whole lines drawn as one widget, which the caret passes over. */
export interface Block {
  from: number;
  to: number;
  kind: "fence-open" | "fence-close" | "frontmatter";
  node: SyntaxNode;
}

export interface Layout {
  blocks: Block[];
  /** Tables, from their first line's start to their last line's end: each is drawn in a box of its own. */
  tables: { from: number; to: number }[];
  /** Line breaks the rendered view hides: blank lines folded into the line above them, a setext heading's underline. */
  merges: { from: number; to: number }[];
  /** Starts of lines that follow a blank line, drawn with paragraph spacing. */
  gaps: number[];
  /** Lines that hold an empty caret and so stay drawn: an empty paragraph, a fence still being typed. */
  exempt: number[];
}

/** Constructs drawn as their source, in a box of their own (RICH-15), and the widget blocks. The caret moves in them as in plain text. */
const BOX = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock", "ProcessingInstructionBlock", "LinkReference", "Frontmatter"]);
/** A table's header row and its body rows, each one line. */
const ROW = /^Table(Header|Row)$/;
/** The one HTML tag a table cell draws: a line break inside the cell (ED-49). */
const BR = /^<br\s*(\/\s*)?>$/i;
/** An anchor's opening tag. Written as `<a id="…"></a>` it draws nothing anywhere, so it hides. */
const ANCHOR = /^<a\s[^>]*\b(?:id|name)\s*=/i;
/** Blocks a blank line may separate. */
const CONTAINERS = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);
/** Inline formatting: visible text between an opening and a closing piece of syntax. */
const INLINE = new Set(["Emphasis", "StrongEmphasis", "Strikethrough", "InlineCode", "Link", "Autolink"]);
const BLANK = /^[\s>]*$/;
const FOOTNOTE = /^\[\^[^\]\s]+\]:/;
/** A Markdown image the rendered view draws: the alt text, then the target. */
export const IMAGE = /^!\[([^\]]*)\]\(\s*<?([^\s>)]+)>?(?:\s+"[^"]*")?\s*\)$/;

interface NodeLike { name: string; from: number; to: number }

/** A footnote definition, which the renderer does not draw and so shows as its source (RICH-15). */
export function isFootnote(state: EditorState, node: NodeLike): boolean {
  return node.name === "Paragraph" && FOOTNOTE.test(state.doc.sliceString(node.from, Math.min(node.to, node.from + 100)));
}

/** An inline construct's extent and the visible text inside its syntax, or null when it is drawn as its source. */
interface Span { name: string; from: number; to: number; cf: number; ct: number }

function span(node: SyntaxNode): Span | null {
  if (node.name === "Link" || node.name === "Autolink") {
    const marks = node.getChildren("LinkMark");
    // `[text]` alone is a reference the parser cannot resolve, so it stays text.
    if (marks.length < 2 || (node.name === "Link" && !node.getChild("URL") && !node.getChild("LinkLabel"))) return null;
    return { name: node.name, from: node.from, to: node.to, cf: marks[0].to, ct: marks[1].from };
  }
  if (!INLINE.has(node.name)) return null;
  const open = node.firstChild;
  const close = node.lastChild;
  if (!open || !close || open.from === close.from || !open.name.endsWith("Mark") || !close.name.endsWith("Mark")) return null;
  return { name: node.name, from: node.from, to: node.to, cf: open.to, ct: close.from };
}

/** The spans enclosing `pos`, innermost first. */
function spansAt(state: EditorState, pos: number, side: -1 | 1): Span[] {
  const out: Span[] = [];
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
    const s = span(n);
    if (s) out.push(s);
  }
  return out;
}

// --- One line ---------------------------------------------------------------

export interface LineSyntax {
  pieces: Piece[];
  objects: Obj[];
  /** The table row the line is, whose cells are its text. */
  row: Row | null;
}

/**
 * The syntax pieces and objects on one line, in document order. A line inside
 * code, frontmatter or a source box has none. `lay` names the lines holding a
 * caret: a backslash that ends a line above an empty one being typed into is
 * the hard break Shift+Enter wrote, and hides like one. A table row's pipes
 * and the spaces around its cells are pieces; the text of each cell is a line
 * of its own as far as its formatting goes, and a `<br>` in it is an object.
 */
export function lineSyntax(state: EditorState, line: Line, lay?: Layout): LineSyntax {
  const { doc } = state;
  let pieces: Piece[] = [];
  let objects: Obj[] = [];
  const opens: Piece[] = [];
  let box = false;
  let row = null as Row | null;
  const spaces = (pos: number, max = Infinity) => {
    let end = pos;
    while (end < line.to && end - pos < max && /[ \t]/.test(doc.sliceString(end, end + 1))) end++;
    return end;
  };
  const add = (p: Piece) => {
    if (p.from >= line.from && p.to <= line.to && p.to > p.from) pieces.push(p);
    return p;
  };
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(n) {
      if (box) return false;
      const name = n.name;
      if (BOX.has(name) || isFootnote(state, n)) {
        box = true;
        return false;
      }
      switch (name) {
        case "TableHeader":
        case "TableRow":
          if (n.from >= line.from && n.to <= line.to) row = rowOf(state, n.node, line);
          return true;
        case "TableDelimiter":
          return false;
        case "HTMLTag": {
          const tag = doc.sliceString(n.from, n.to);
          if (row && BR.test(tag)) objects.push({ from: n.from, to: n.to, name });
          else if (ANCHOR.test(tag) && doc.sliceString(n.to, n.to + 4).toLowerCase() === "</a>") add({ from: n.from, to: n.to + 4, after: true, block: false, draw: "hide" });
          return false;
        }
        case "HeaderMark": {
          const heading = n.node.parent;
          if (!heading?.name.startsWith("ATXHeading")) return false;
          if (n.from === heading.from) add({ from: n.from, to: spaces(n.to), after: true, block: true, draw: "hide" });
          else add({ from: n.from - (doc.sliceString(n.from - 1, n.from) === " " ? 1 : 0), to: n.to, after: false, block: false, draw: "hide" });
          return false;
        }
        case "EmphasisMark":
        case "StrikethroughMark":
        case "CodeMark": {
          const parent = n.node.parent;
          if (!parent || !span(parent)) return false;
          const open = n.from === parent.from;
          // In a table cell GFM reads `\|` as `|` even inside a code span, so
          // that backslash hides like an escape's (ED-49, RICH-04).
          if (!open && row && parent.name === "InlineCode") {
            const from = parent.firstChild?.to ?? parent.from;
            const text = doc.sliceString(from, n.from);
            for (let i = text.indexOf("\\|"); i >= 0; i = text.indexOf("\\|", i + 2)) add({ from: from + i, to: from + i + 1, after: false, block: false, draw: "hide", glue: true });
          }
          const p = add({ from: n.from, to: n.to, after: false, block: false, draw: "hide", open });
          if (open) opens.push(p);
          return false;
        }
        case "QuoteMark":
          add({ from: n.from, to: spaces(n.to, 1), after: true, block: true, draw: "hide" });
          return false;
        case "ListMark": {
          const list = n.node.parent?.parent;
          let level = 0;
          for (let p = list?.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") level++;
          // A checklist item shows its box alone, as GitHub draws it.
          const task = !!n.node.parent?.getChild("Task");
          add({ from: n.from, to: spaces(n.to), after: true, block: true, draw: task ? "hide" : list?.name === "BulletList" ? "bullet" : "keep", mark: n.to, level });
          return false;
        }
        case "TaskMarker":
          add({ from: n.from, to: spaces(n.to, 1), after: true, block: true, draw: "task", mark: n.to, checked: /x/i.test(doc.sliceString(n.from, n.to)) });
          return false;
        case "Escape":
          add({ from: n.from, to: n.from + 1, after: false, block: false, draw: "hide", glue: true });
          return false;
        case "HardBreak":
          if (doc.sliceString(n.from, n.from + 1) === "\\") add({ from: n.from, to: n.from + 1, after: false, block: false, draw: "hide", glue: true });
          else add({ from: n.from, to: Math.min(n.to, line.to), after: false, block: false, draw: "keep" });
          return false;
        case "Link":
        case "Autolink": {
          const s = span(n.node);
          if (s) {
            add({ from: s.from, to: s.cf, after: false, block: false, draw: "hide", open: true });
            add({ from: s.ct, to: s.to, after: true, block: false, draw: "hide" });
          }
          return name === "Link";
        }
        case "Image":
          if (n.to <= line.to && n.from >= line.from && IMAGE.test(doc.sliceString(n.from, n.to))) {
            objects.push({ from: n.from, to: n.to, name });
            return false;
          }
          return true;
        case "Citation":
        case "HorizontalRule":
          objects.push({ from: n.from, to: n.to, name });
          return false;
      }
      return true;
    },
  });
  if (box) return { pieces: [], objects: [], row: null };
  if (row) {
    // Whatever sits in a row's separators — a quote's marks before a quoted
    // table, the cells past the header's width — is hidden with them.
    const seps = separators(row);
    const hidden = (r: { from: number; to: number }) => seps.some((s) => r.from < s.to && r.to > s.from);
    pieces = pieces.filter((p) => !hidden(p));
    objects = objects.filter((o) => !hidden(o));
    seps.forEach((s, i) => add(
      i === 0 ? { ...s, after: true, block: true, draw: "hide" }
      : i === seps.length - 1 ? { ...s, after: false, block: false, draw: "hide" }
      : { ...s, after: false, block: false, draw: "hide", cell: true },
    ));
    // An empty cell's one space is drawn, and is one place for the caret, after it.
    for (const c of row.cells) if (c.to > c.from && !doc.sliceString(c.from, c.to).trim()) add({ ...c, after: true, block: true, draw: "keep" });
  } else if (lay && line.number < doc.lines && lay.exempt.includes(line.number + 1) && /(^|[^\\])(\\\\)*\\$/.test(line.text) && BLANK.test(doc.line(line.number + 1).text)) {
    add({ from: line.to - 1, to: line.to, after: false, block: false, draw: "hide", glue: true });
  }
  pieces.sort((a, b) => a.from - b.from || a.to - b.to);
  // Indentation before a line's first mark or word is block syntax too; and
  // an opening mark with nothing visible before it on the line, or in its
  // table cell, takes typed text after it, as a word processor gives the
  // start of a paragraph the formatting of its first word.
  const lead: Piece[] = [];
  const leads: { from: number; to: number }[] = [];
  const walk = (start: number, i: number) => {
    let pos = start;
    for (; ; i++) {
      const next = i < pieces.length ? pieces[i] : null;
      const ws = row ? pos : spaces(pos);
      if (ws > pos && ws <= (next ? Math.max(pos, next.from) : line.to)) lead.push({ from: pos, to: ws, after: true, block: true, draw: "keep" });
      if (!next || next.cell || ws < next.from) break;
      pos = Math.max(pos, next.to);
    }
    leads.push({ from: start, to: pos });
  };
  walk(line.from, 0);
  if (row) pieces.forEach((p, i) => { if (p.cell) walk(p.to, i + 1); });
  for (const p of opens) if (leads.some((l) => p.from >= l.from && p.to <= l.to)) p.after = true;
  pieces.push(...lead);
  pieces.sort((a, b) => a.from - b.from || a.to - b.to);
  objects.sort((a, b) => a.from - b.from);
  return { pieces, objects, row };
}

// --- The whole document ------------------------------------------------------

/** The lines that hold an empty caret and so stay drawn: a blank line being typed into, or a fence being typed. */
export function exemptLines(state: EditorState): number[] {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    if (!r.empty) continue;
    const line = state.doc.lineAt(r.head);
    if (BLANK.test(line.text) || unclosedFence(state, line)) out.add(line.number);
  }
  return [...out].sort((a, b) => a - b);
}

function fenceAt(state: EditorState, line: Line): SyntaxNode | null {
  const at = line.from + /^\s*/.exec(line.text)![0].length;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(at, 1); n; n = n.parent) {
    if (n.name === "FencedCode") return state.doc.lineAt(n.from).number === line.number ? n : null;
  }
  return null;
}

/** The info string on the code fence line at `pos`, or the empty range after the fence where one goes; and the fence itself. */
export function infoRange(state: EditorState, pos: number): { from: number; to: number; fence: string } | null {
  const fence = fenceAt(state, state.doc.lineAt(pos));
  const mark = fence?.getChild("CodeMark");
  if (!fence || !mark) return null;
  const info = fence.getChild("CodeInfo");
  return { from: info ? info.from : mark.to, to: info ? info.to : mark.to, fence: state.doc.sliceString(mark.from, mark.to) };
}

/** A fence's first line when no closing fence follows it: what has just been typed. */
function unclosedFence(state: EditorState, line: Line): SyntaxNode | null {
  const fence = fenceAt(state, line);
  if (!fence) return null;
  const marks = fence.getChildren("CodeMark");
  return marks.length < 2 || marks[marks.length - 1].from <= line.to ? fence : null;
}

/**
 * The document's block-level drawing: which lines are widgets, which line
 * breaks are hidden, which lines open with paragraph spacing. A run of blank
 * lines is folded into the line above it, or into the widget above it; one
 * holding a caret in `exempt` stays drawn as an empty paragraph.
 */
export function layout(state: EditorState, exempt: readonly number[]): Layout {
  const { doc } = state;
  const tree = syntaxTree(state);
  const blocks: Block[] = [];
  const tables: { from: number; to: number }[] = [];
  const merges: { from: number; to: number }[] = [];
  const gaps: number[] = [];
  const held = new Set(exempt);
  // Blocks a blank line can sit inside of, where it is content, not a separator.
  const boxes: { from: number; to: number }[] = [];
  tree.iterate({
    enter(n) {
      switch (n.name) {
        case "Frontmatter":
          blocks.push({ from: doc.lineAt(n.from).from, to: doc.lineAt(Math.max(n.from, n.to - 1)).to, kind: "frontmatter", node: n.node });
          boxes.push({ from: n.from, to: n.to });
          return false;
        case "Table": {
          // A table is its own lines, drawn as rows; the delimiter row is hidden in the header's line.
          const head = doc.lineAt(n.from);
          const delimiter = n.node.getChild("TableDelimiter");
          if (delimiter) merges.push({ from: head.to, to: doc.lineAt(delimiter.from).to });
          tables.push({ from: head.from, to: doc.lineAt(Math.max(n.from, n.to - 1)).to });
          return false;
        }
        case "FencedCode": {
          const open = doc.lineAt(n.from);
          const marks = n.node.getChildren("CodeMark");
          const last = marks[marks.length - 1];
          const close = marks.length > 1 && last.from > open.to ? doc.lineAt(last.from) : null;
          if (close || !held.has(open.number)) blocks.push({ from: open.from, to: open.to, kind: "fence-open", node: n.node });
          if (close) blocks.push({ from: close.from, to: close.to, kind: "fence-close", node: n.node });
          boxes.push({ from: n.from, to: n.to });
          return false;
        }
        case "SetextHeading1":
        case "SetextHeading2": {
          const under = doc.lineAt(n.to);
          if (under.number > 1) merges.push({ from: doc.line(under.number - 1).to, to: under.to });
          return false;
        }
      }
      if (BOX.has(n.name)) boxes.push({ from: n.from, to: n.to });
      return CONTAINERS.has(n.name);
    },
  });
  const ends = new Map(blocks.map((b) => [b.to, b]));
  // The blank lines, walked once in order; a run of them folds into the line above.
  let box = 0;
  let run: { first: number; from: number; to: number; last: number } | null = null;
  let prevTo = -1;
  let number = 0;
  const close = (next: number) => {
    if (!run) return;
    if (run.first > 1) {
      const block = ends.get(prevTo);
      if (!block) merges.push({ from: prevTo, to: run.to });
      else if (next > 0 || run.last > run.first) {
        // A widget takes the blank lines after it, but never the document's
        // last line: the caret has to have somewhere below a closing table.
        block.to = next > 0 ? run.to : run.to - (doc.lineAt(run.to).length + 1);
      }
    }
    if (next > 0) gaps.push(next);
    run = null;
  };
  for (let iter = doc.iterLines(), pos = 0; !iter.next().done; pos += iter.value.length + 1) {
    number++;
    const text = iter.value;
    while (box < boxes.length && boxes[box].to < pos) box++;
    const blank = !held.has(number) && BLANK.test(text) && !(box < boxes.length && boxes[box].from <= pos);
    if (blank) {
      if (run) { run.to = pos + text.length; run.last = number; }
      else run = { first: number, from: pos, to: pos + text.length, last: number };
    } else {
      close(pos);
      prevTo = pos + text.length;
    }
  }
  close(-1);
  merges.sort((a, b) => a.from - b.from);
  return { blocks, tables, merges, gaps, exempt: [...exempt] };
}

const BLOCK_NODE = /^(Document|Blockquote|BulletList|OrderedList|ListItem|Paragraph|ATXHeading\d|SetextHeading\d|HorizontalRule|Task|FencedCode|CodeBlock|HTMLBlock|CommentBlock|ProcessingInstructionBlock|LinkReference|Table|Frontmatter)$/;

/** The blocks on either side of `pos`, innermost first, each with the lines it spans. */
function blocksAround(state: EditorState, pos: number): string {
  const out: string[] = [];
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (BLOCK_NODE.test(n.name)) out.push(`${n.name}:${state.doc.lineAt(n.from).number}-${state.doc.lineAt(n.to).number}`);
    }
    out.push("|");
  }
  return out.join(" ");
}

/**
 * Whether `lay`, worked out for the state before `tr`, still holds after it,
 * moved by its changes: no change adds or removes a line break, turns a blank
 * line into text or back, or touches a widget block, and each leaves the
 * blocks around it the same kinds over the same lines. Typing in a paragraph
 * is such a change, so the document is not laid out again for every key.
 */
export function layoutHolds(tr: Transaction, lay: Layout): boolean {
  let holds = true;
  const before = tr.startState;
  tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    if (!holds) return;
    const a = before.doc.lineAt(fromA);
    const b = tr.state.doc.lineAt(fromB);
    const block = blockAt(lay, fromA) ?? blockAt(lay, toA);
    holds = inserted.lines === 1 && toA <= a.to && !block && BLANK.test(a.text) === BLANK.test(b.text)
      && blocksAround(before, fromA) === blocksAround(tr.state, fromB);
  });
  return holds;
}

/** `lay` moved through `changes`, which `layoutHolds` accepted. */
export function mapLayout(lay: Layout, changes: ChangeDesc): Layout {
  return {
    blocks: lay.blocks.map((b) => ({ ...b, from: changes.mapPos(b.from, -1), to: changes.mapPos(b.to, 1) })),
    tables: lay.tables.map((t) => ({ from: changes.mapPos(t.from, -1), to: changes.mapPos(t.to, 1) })),
    merges: lay.merges.map((m) => ({ from: changes.mapPos(m.from, 1), to: changes.mapPos(m.to, 1) })),
    gaps: lay.gaps.map((g) => changes.mapPos(g, -1)),
    exempt: lay.exempt,
  };
}

/** Index of the last item starting at or before `pos`, or -1. */
function lastFrom<T extends { from: number }>(list: readonly T[], pos: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].from <= pos) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function blockAt(lay: Layout, pos: number): Block | undefined {
  const b = lay.blocks[lastFrom(lay.blocks, pos)];
  return b && b.to >= pos ? b : undefined;
}

/** The hidden line break that covers `pos` past its start. */
function mergeOver(lay: Layout, pos: number) {
  const m = lay.merges[lastFrom(lay.merges, pos - 1)];
  return m && m.from < pos && m.to >= pos ? m : undefined;
}

function mergeFrom(lay: Layout, pos: number) {
  const m = lay.merges[lastFrom(lay.merges, pos)];
  return m && m.from === pos ? m : undefined;
}

// --- Where the caret stands --------------------------------------------------

/** A run of syntax with no visible character in it: one place on screen, however many positions it spans. */
export interface Run {
  from: number;
  to: number;
  pieces: Piece[];
  /** The table row the run's line is. */
  row: Row | null;
}

/**
 * The run of hidden syntax holding `pos`, or the empty run at `pos`. Two
 * cells of a table row never share a run: the pipe between them is a run of
 * its own, which holds only the positions strictly inside it. A position in a
 * cell's tail (`cellTail`) is in no run.
 */
export function runAt(state: EditorState, lay: Layout, pos: number): Run {
  let at = pos;
  // A position on a hidden blank line belongs to the line it is folded into.
  for (let m = mergeOver(lay, at); m; m = mergeOver(lay, at)) at = m.from;
  const line = state.doc.lineAt(at);
  const syntax = lineSyntax(state, line, lay);
  const { row } = syntax;
  if (row && cellTail(state, row, pos)) return { from: pos, to: pos, pieces: [], row };
  const pieces = syntax.pieces.slice();
  for (let end = line.to, m = mergeFrom(lay, end); m; end = m.to, m = mergeFrom(lay, end)) {
    pieces.push({ from: m.from, to: m.to, after: false, block: false, draw: "hide", merge: true, glue: true });
  }
  let run: Run | null = null;
  for (const p of pieces) {
    if (p.cell) {
      if (run && run.from <= pos && run.to >= pos) return run;
      run = null;
      if (p.from < pos && pos < p.to) return { from: p.from, to: p.to, pieces: [p], row };
      continue;
    }
    if (run && p.from <= run.to) {
      run.to = Math.max(run.to, p.to);
      run.pieces.push(p);
      continue;
    }
    if (run && run.from <= pos && run.to >= pos) return run;
    run = { from: p.from, to: p.to, pieces: [p], row };
  }
  return run && run.from <= pos && run.to >= pos ? run : { from: pos, to: pos, pieces: [], row };
}

/**
 * The side a caret at `pos` is drawn on in a table row: after the position at
 * the start of a cell's text, before it at the end and in the cell's tail, so
 * that a caret beside a hidden pipe shows, and types, in the cell it belongs
 * to. A cell with nothing between its pipes is drawn by a widget before its
 * one position.
 */
function edgeSide(cells: readonly { from: number; to: number }[], pos: number): -1 | 0 | 1 {
  for (const c of cells) {
    if (c.from === pos) return c.to === pos ? -1 : 1;
    if (c.to === pos) return -1;
  }
  return 0;
}

function cellSide(state: EditorState, row: Row | null, pos: number): -1 | 0 | 1 {
  return row ? edgeSide(row.cells, pos) || (cellTail(state, row, pos) ? -1 : 0) : 0;
}

/**
 * The side of `pos`, a caret in the document after `changes`, as `cellSide`
 * gives it, read from `state`, the document before them, whose cell edges
 * move with an edit inside their row. Text typed at a cell's edge stays in
 * that cell, so the new state is not needed to place the caret.
 */
export function caretSide(state: EditorState, pos: number, changes: ChangeDesc): -1 | 0 | 1 {
  if (changes.empty) return cellSide(state, tableRow(state, pos), pos);
  const was = changes.invertedDesc.mapPos(pos, -1);
  const row = tableRow(state, was);
  if (!row) return 0;
  return edgeSide(row.cells.map((c) => ({ from: changes.mapPos(c.from, -1), to: changes.mapPos(c.to, 1) })), pos) || (cellTail(state, row, was) ? -1 : 0);
}

/** `pos`, moved off any widget block in direction `dir`, or the way the block prefers. */
function offBlocks(state: EditorState, lay: Layout, pos: number, dir: number): number {
  for (let b = blockAt(lay, pos); b; b = blockAt(lay, pos)) {
    const d = dir || (b.kind === "fence-close" ? -1 : 1);
    const ahead = b.to < state.doc.length ? b.to + 1 : -1;
    const behind = b.from > 0 ? b.from - 1 : -1;
    const next = d > 0 ? (ahead >= 0 ? ahead : behind) : behind >= 0 ? behind : ahead;
    if (next < 0) return pos;
    dir = next > pos ? 1 : -1;
    pos = next;
  }
  return pos;
}

/**
 * Where the caret stands for position `pos`: off any widget, and at the one
 * position of its run that typing continues from (RICH-03). Typed text joins
 * the visible text before the caret and takes its formatting; at the start of
 * a line, or of a table cell, it joins the text after the caret instead; it
 * always goes after a block's marks, and never inside a link at either end of
 * its text.
 */
export function canonical(state: EditorState, lay: Layout, pos: number, dir: number): SelectionRange {
  pos = offBlocks(state, lay, pos, dir);
  const run = runAt(state, lay, pos);
  if (!run.pieces.length) return EditorSelection.cursor(pos, cellSide(state, run.row, pos));
  let at = run.from;
  for (const p of run.pieces) if (p.after) at = Math.max(at, p.to);
  return EditorSelection.cursor(at, cellSide(state, run.row, at) || (at === run.from ? -1 : 1));
}

/**
 * Whether text typed at `pos` keeps every construct around it whole: `pos`
 * is inside no piece, after its line's block marks, and not between a
 * backslash and what it escapes. Positions in one run other than the
 * canonical one are safe or not; after a word's closing marks is safe, and
 * is where a word typed as `**word**` leaves the caret.
 */
export function safe(state: EditorState, lay: Layout, pos: number): boolean {
  if (blockAt(lay, pos)) return false;
  const run = runAt(state, lay, pos);
  return run.pieces.every((p) => (p.from >= pos || p.to <= pos) && !(p.block && p.to > pos) && !(p.glue && p.to === pos));
}

/** The caret a pointer, a key or the other view put at `pos`: kept when `keep` and safe, else canonical. */
export function settle(state: EditorState, lay: Layout, range: SelectionRange, dir: number, keep: boolean): SelectionRange {
  return keep && safe(state, lay, range.head) ? range : canonical(state, lay, range.head, dir);
}

/**
 * One visible step: a character, an object, a line break with any hidden
 * lines and widgets it passes, or the pipe between two table cells, whose
 * `char` is a tab.
 */
export interface Unit { from: number; to: number; char: string; blocks: boolean }

/** The visible unit next to the run holding `pos`, or null at the document's edge. */
export function step(state: EditorState, lay: Layout, pos: number, forward: boolean): Unit | null {
  const { doc } = state;
  const run = runAt(state, lay, pos);
  // In a cell's tail the spaces before the caret are text, and the pipe after it ends the cell.
  const tail = run.row && !run.pieces.length ? cellTail(state, run.row, pos) : null;
  if (tail) {
    if (!forward) return { from: pos - 1, to: pos, char: doc.sliceString(pos - 1, pos), blocks: false };
    const u = step(state, lay, tail.from, true);
    return u && { ...u, from: pos };
  }
  const p = forward ? run.to : run.from;
  const line = doc.lineAt(p);
  const { pieces, objects } = lineSyntax(state, line);
  const wall = pieces.find((w) => w.cell && (forward ? w.from === p : w.to === p));
  if (wall) return { from: wall.from, to: wall.to, char: "\t", blocks: false };
  const obj = objects.find((o) => (forward ? o.from === p : o.to === p));
  if (obj) return { from: obj.from, to: obj.to, char: "￼", blocks: false };
  if (forward ? p < line.to : p > line.from) {
    const q = findClusterBreak(line.text, p - line.from, forward) + line.from;
    return forward ? { from: p, to: q, char: doc.sliceString(p, q), blocks: false } : { from: q, to: p, char: doc.sliceString(q, p), blocks: false };
  }
  let q = forward ? p + 1 : p - 1;
  if (q < 0 || q > doc.length) return null;
  let blocks = false;
  for (let b = blockAt(lay, q); b && (forward ? b.from === q : b.to === q); b = blockAt(lay, q)) {
    q = forward ? b.to + 1 : b.from - 1;
    if (q < 0 || q > doc.length) return null;
    blocks = true;
  }
  return forward ? { from: p, to: q, char: "\n", blocks } : { from: q, to: p, char: "\n", blocks };
}

/** An arrow key: one visible character, never a hidden one (RICH-02). */
export function moveChar(state: EditorState, lay: Layout, range: SelectionRange, forward: boolean, extend: boolean): SelectionRange {
  if (!extend && !range.empty) return canonical(state, lay, forward ? range.to : range.from, forward ? 1 : -1);
  const u = step(state, lay, range.head, forward);
  if (!u) return range;
  const to = canonical(state, lay, forward ? u.to : u.from, forward ? 1 : -1);
  return extend ? EditorSelection.range(range.anchor, to.head) : to;
}

/**
 * Where a word step from `pos` ends: spaces, then a run of one kind of
 * character, as the editor's own word motion goes. Unless it `crosses` lines,
 * it stops at a line break and at a table cell's edge.
 */
function wordEdge(state: EditorState, lay: Layout, pos: number, forward: boolean, crosses: boolean): number {
  const categorize = state.charCategorizer(pos);
  let kind: CharCategory | null = null;
  for (;;) {
    const u = step(state, lay, pos, forward);
    if (!u || (!crosses && (u.char === "\n" || u.char === "\t"))) return pos;
    const c = u.char === "￼" ? CharCategory.Word : categorize(u.char);
    if (kind === null || kind === CharCategory.Space) kind = c;
    else if (c !== kind) return pos;
    pos = forward ? u.to : u.from;
  }
}

/** Ctrl+arrow: a word at a time over the visible text. */
export function moveGroup(state: EditorState, lay: Layout, range: SelectionRange, forward: boolean, extend: boolean): SelectionRange {
  const to = canonical(state, lay, wordEdge(state, lay, range.head, forward, true), forward ? 1 : -1);
  return extend ? EditorSelection.range(range.anchor, to.head) : to;
}

// --- What an edit writes ----------------------------------------------------

/**
 * The ranges to delete for the visible text between `from` and `to`. A
 * construct whose whole text goes is deleted with its syntax, so no empty
 * `****` or `[](…)` is left behind (RICH-02); a construct only partly inside
 * keeps its syntax. With `typed`, text is about to replace the range, and a
 * construct whose text is exactly the range keeps its syntax to hold it. A
 * table the range only partly covers loses the text of its cells and keeps
 * its pipes and rows (`tableSyntax`); a code block or frontmatter keeps its
 * fences (`fenceSyntax`).
 */
export function deletion(state: EditorState, from: number, to: number, typed = false): { from: number; to: number }[] {
  const tree = syntaxTree(state);
  const exact = { from, to };
  for (let grown = true; grown; ) {
    grown = false;
    tree.iterate({
      from,
      to,
      enter(n) {
        if (n.name === "Escape" || n.name === "HardBreak") {
          // A backslash goes with the character or line break it stands before.
          const after = n.name === "Escape" ? n.from + 1 : n.to - 1;
          if (after >= from && n.to <= to && n.from < from) { from = n.from; grown = true; }
          return false;
        }
        const s = INLINE.has(n.name) ? span(n.node) : null;
        if (s && s.cf < s.ct && s.cf >= from && s.ct <= to && (s.from < from || s.to > to) && !(typed && s.cf === exact.from && s.ct === exact.to)) {
          from = Math.min(from, s.from);
          to = Math.max(to, s.to);
          grown = true;
        }
        return undefined;
      },
    });
  }
  const kept: { from: number; to: number }[] = [];
  tree.iterate({
    from,
    to,
    enter(n) {
      if (n.name === "Table") {
        kept.push(...tableSyntax(state, n.node, from, to));
        return;
      }
      if (n.name === "FencedCode" || n.name === "Frontmatter") {
        kept.push(...fenceSyntax(state, n.node, from, to));
        return false;
      }
      const s = INLINE.has(n.name) ? span(n.node) : null;
      if (!s || (s.from >= from && s.to <= to)) return;
      for (const [a, b] of [[s.from, s.cf], [s.ct, s.to]]) {
        if (Math.min(b, to) > Math.max(a, from)) kept.push({ from: Math.max(a, from), to: Math.min(b, to) });
      }
    },
  });
  kept.sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  let pos = from;
  for (const k of kept) {
    if (k.from > pos) out.push({ from: pos, to: k.from });
    pos = Math.max(pos, k.to);
  }
  if (to > pos) out.push({ from: pos, to });
  return out;
}

// --- Keeping constructs whole (RICH-18) --------------------------------------

/** A change in the positions of the document before it: text deleted, text written in its place, or both. */
export interface Change { from: number; to: number; insert?: string }

const SPACE = /^[ \t]$/;
/** Characters that are inline syntax, or turn into it beside new neighbours. */
const SPECIAL = /[\\`*_~[\]()<>!&]/;
/** A line's start up to its text: indentation, quote marks, a list item's mark and task box, a heading's marks. */
const LINE_HEAD = /^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?$/;
/** Blocks whose text is inline content. */
const TEXT_BLOCK = /^(Paragraph|ATXHeading\d|SetextHeading\d|Task|TableCell)$/;
/** A no-break space: no indentation to the block parser, so text after it opens no block. */
const NBSP = String.fromCharCode(0xa0);

const pureDeletion = (c: Change | undefined): c is Change => !!c && !c.insert && c.to > c.from;

/**
 * Takes the whitespace a deletion in `list` leaves against the inside of a
 * construct's marks out of it: a closing mark after whitespace no longer
 * closes, nor an opening one before it, so deleting `and` from `**bold and**`
 * has to leave `**bold**`, not `**bold **`. Where a line's edge stands outside
 * the marks, or whitespace does, the whitespace goes; where a word does, or
 * with `keep`, which a Backspace or Delete of one character passes so that it
 * takes one visible character, the marks move in over the whitespace instead.
 * Whitespace reaching back across a soft line break takes the line break too,
 * and the two lines join. `list` is sorted, and changed in place; whether
 * anything moved.
 */
function hug(state: EditorState, list: Change[], keep: boolean): boolean {
  const { doc } = state;
  const char = (pos: number) => (pos < 0 ? "" : doc.sliceString(pos, pos + 1));
  const stays = (o: string) => !(o === "" || o === "\n" || (SPACE.test(o) && !keep));
  // The kept text of `from`–`to` outside the deletions list[a] to list[b - 1].
  const kept = (from: number, to: number, a: number, b: number) => {
    let text = "";
    for (let k = a; k < b; k++) { text += doc.sliceString(from, list[k].from); from = list[k].to; }
    return text + doc.sliceString(from, to);
  };
  // Marks moved in over whitespace, written after any text written at the same place.
  const extra: Change[] = [];
  let moved = false;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!pureDeletion(c)) continue;
    // Closing marks right after the deletion, nested ones and deletions among them included.
    let end = c.to;
    let j = i + 1;
    let inner: Span | undefined;
    for (let more = true; more; ) {
      more = false;
      const s = spansAt(state, end, 1).find((s) => s.ct === end && s.cf < s.ct);
      if (s) { inner ??= s; end = s.to; more = true; }
      for (; pureDeletion(list[j]) && list[j].from === end; j++) { end = list[j].to; more = true; }
    }
    if (inner) {
      const floor = Math.max(inner.cf, i ? list[i - 1].to : 0);
      let w = c.from;
      while (w > floor && SPACE.test(char(w - 1))) w--;
      const line = doc.lineAt(w);
      if (line.from - 1 > floor && /^[ \t>]*$/.test(doc.sliceString(line.from, w)) && char(line.from - 2) !== "\\") {
        w = line.from - 1;
        while (w > floor && SPACE.test(char(w - 1))) w--;
      }
      if (w < c.from && w > inner.cf) {
        const o = list[j]?.from === end ? (list[j].insert ?? "").charAt(0) : char(end);
        if (stays(o)) {
          extra.push({ from: w, to: w, insert: kept(c.to, end, i + 1, j) });
          list.splice(i + 1, j - i - 1);
          c.to = end;
        } else c.from = w;
        moved = true;
        continue;
      }
    }
    // Opening marks right before it.
    let start = c.from;
    let k = i - 1;
    inner = undefined;
    for (let more = true; more; ) {
      more = false;
      const s = spansAt(state, start, -1).find((s) => s.cf === start && s.cf < s.ct);
      if (s) { inner ??= s; start = s.from; more = true; }
      for (; pureDeletion(list[k]) && list[k].to === start; k--) { start = list[k].from; more = true; }
    }
    if (!inner) continue;
    const ceiling = Math.min(inner.ct, list[i + 1]?.from ?? doc.length);
    let w = c.to;
    while (w < ceiling && SPACE.test(char(w))) w++;
    if (w < ceiling && char(w) === "\n") {
      const next = doc.lineAt(w + 1);
      const lead = next.from + /^[ \t>]*/.exec(next.text)![0].length;
      if (lead < ceiling) w = lead;
    }
    if (w > c.to && w < inner.ct) {
      const prev = list[k];
      const o = prev && prev.to === start && prev.insert ? prev.insert.charAt(prev.insert.length - 1)
        : LINE_HEAD.test(doc.sliceString(doc.lineAt(start).from, start)) ? "\n" : char(start - 1);
      if (stays(o)) {
        extra.push({ from: w, to: w, insert: kept(start, c.from, k + 1, i) });
        list.splice(k + 1, i - k - 1);
        i = k + 1;
        c.from = start;
      } else c.to = w;
      moved = true;
    }
  }
  list.push(...extra);
  list.sort((a, b) => a.from - b.from);
  return moved;
}

/** A construct as a fresh parse reads it. */
interface Over { name: string; from: number; to: number; cf: number; ct: number }

/** Positions `tree` reads as syntax that shows nothing, and its constructs, `offset` before the positions of a text `length` long. */
function scan(tree: Tree, offset: number, length: number, from?: number, to?: number): { hidden: Uint8Array; spans: Over[] } {
  const hidden = new Uint8Array(length);
  const spans: Over[] = [];
  tree.iterate({
    from,
    to,
    enter(n) {
      const a = Math.max(0, n.from - offset);
      const b = Math.max(0, n.to - offset);
      if (/Mark$|^(LinkTitle|LinkLabel|HardBreak)$/.test(n.name) || (n.name === "URL" && /^(Link|Image)$/.test(n.node.parent?.name ?? ""))) {
        hidden.fill(1, a, b);
        return false;
      }
      if (n.name === "Escape") {
        hidden[a] = 1;
        return false;
      }
      const s = n.name === "Image" ? { name: n.name, from: n.from, to: n.to, cf: n.from, ct: n.to } : INLINE.has(n.name) ? span(n.node) : null;
      if (s) spans.push({ name: s.name, from: s.from - offset, to: s.to - offset, cf: s.cf - offset, ct: s.ct - offset });
      return undefined;
    },
  });
  return { hidden, spans };
}

/** Text blocks' text with the quote marks and indentation that start a continuation line as the spaces they are inside their quote. */
const unquoted = (raw: string) => raw.replace(/\n[ \t>]*/g, (m) => `\n${" ".repeat(m.length - 1)}`);

/**
 * `text`, a text block's, as `parser` reads it standing alone. `lead`, a
 * no-break space before a heading's, checklist item's or cell's text, keeps a
 * `#` or `-` there from opening a block.
 */
function read(parser: Parser, text: string, lead: string): { hidden: Uint8Array; spans: Over[] } {
  return scan(parser.parse(lead + text), lead.length, text.length);
}

/** Text blocks' text, and for each position whether it is hidden syntax and which constructs are over it, as an index into `sets`. */
interface Reading { from: number; text: string; hidden: Uint8Array; over: Int32Array; sets: string[][] }

/** `r`, of `doc`, as `parser` reads it standing alone, or as `tree`, the document's own parse, reads it. */
function reading(doc: Text, r: Region, parser: Parser | null, tree?: Tree): Reading {
  const text = unquoted(doc.sliceString(r.from, r.to));
  const { hidden, spans } = tree ? scan(tree, r.from, text.length, r.from, r.to) : read(parser!, text, r.lead);
  const over = new Int32Array(text.length);
  const sets: string[][] = [[]];
  let active: Over[] = [];
  for (let p = 0, n = 0, id = 0; p < text.length; p++) {
    let changed = false;
    if (active.some((o) => o.to <= p)) { active = active.filter((o) => o.to > p); changed = true; }
    for (; n < spans.length && spans[n].from <= p; n++) if (spans[n].to > p) { active = [...active, spans[n]]; changed = true; }
    if (changed) { id = sets.length; sets.push(active.map((o) => o.name)); }
    over[p] = id;
  }
  return { from: r.from, text, hidden, over, sets };
}

/**
 * The text of the text block holding `pos` — a paragraph, a heading, a
 * checklist item, a table cell — past a heading's marks and a checklist item's
 * box, and whether it reads standing alone as a paragraph does.
 */
function textBlock(state: EditorState, pos: number): Region | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (!TEXT_BLOCK.test(n.name)) continue;
      let { from, to } = n;
      const first = n.firstChild;
      const last = n.lastChild;
      if (n.name.startsWith("ATXHeading")) {
        if (first?.name === "HeaderMark") from = first.to;
        if (last?.name === "HeaderMark" && last.from > (first?.from ?? -1)) to = last.from;
      } else if (n.name.startsWith("SetextHeading")) {
        if (last?.name === "HeaderMark") to = state.doc.lineAt(last.from).from - 1;
      } else if (n.name === "Task" && first?.name === "TaskMarker") from = first.to;
      return { from, to: Math.max(from, to), lead: /^(Paragraph|SetextHeading)/.test(n.name) ? "" : NBSP };
    }
  }
  return null;
}

type Region = { from: number; to: number; lead: string };

const blank = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || (c > 127 && /\s/.test(String.fromCharCode(c)));

/**
 * The constructs whose marks `set` keeps but which no longer read as
 * themselves in a fresh parse of the text blocks it touches: their marks show
 * as text, or text under them lost them. Null when every visible character
 * `set` leaves in place reads as before, under the same constructs (RICH-18);
 * `before` is the blocks' reading before it. A plain delimiter a deletion
 * brings beside another is free to pair with it, as the source view reads it:
 * that is how `**bold **`, a space typed after a bold word, turns bold again
 * when the space goes. Constructs in `gone` are losing their marks. One that
 * cannot be named, a hidden backslash shown say, leaves the list empty.
 */
function broken(state: EditorState, parser: Parser, blocks: readonly Region[], before: readonly Reading[], set: ChangeSet, gone: readonly Over[]): Span[] | null {
  const next = set.apply(state.doc);
  // Blocks the changes run together are read as one; so are paragraphs no blank line parts any more.
  const regions: Region[] = [];
  for (const b of blocks) {
    const r = { from: set.mapPos(b.from, -1), to: set.mapPos(b.to, 1), lead: b.lead };
    const last = regions[regions.length - 1];
    if (last && (r.from <= last.to || (!last.lead && !r.lead && !/\n[ \t>]*\n/.test(next.sliceString(last.to, r.from))))) last.to = Math.max(last.to, r.to);
    else regions.push(r);
  }
  const after = regions.map((r) => reading(next, r, parser));
  let bad = false;
  const out = new Map<number, Span>();
  const blame = (s: Span | undefined) => { if (s) out.set(s.from, s); };
  const subset = new Map<number, boolean>();
  let r = 0;
  // Each stretch `set` leaves alone, from the blocks read before it into those read after.
  set.iterGaps((posA, posB, length) => {
    for (const b of before) {
      const end = Math.min(posA + length, b.from + b.text.length);
      for (let p = Math.max(posA, b.from); p < end; p++) {
        const i = p - b.from;
        if (blank(b.text.charCodeAt(i))) continue;
        const q = p - posA + posB;
        while (r < after.length && after[r].from + after[r].text.length <= q) r++;
        const a = after[r];
        if (!a || q < a.from) continue;
        const j = q - a.from;
        // Syntax that stays syntax, and plain text turned syntax, pass.
        if (a.hidden[j] || blank(a.text.charCodeAt(j))) continue;
        if (b.hidden[i]) {
          bad = true;
          blame(spansAt(state, p, 1).find((s) => (s.from <= p && p < s.cf) || (s.ct <= p && p < s.to)));
          continue;
        }
        const key = b.over[i] * 0x100000 + a.over[j];
        let ok = subset.get(key);
        if (ok === undefined) subset.set(key, ok = b.sets[b.over[i]].every((n) => a.sets[a.over[j]].includes(n)));
        if (ok) continue;
        for (const name of b.sets[b.over[i]]) {
          if (a.sets[a.over[j]].includes(name) || gone.some((g) => g.name === name && g.from <= p && p < g.to)) continue;
          bad = true;
          blame(spansAt(state, p, 1).find((s) => s.name === name));
        }
      }
    }
  });
  return bad ? [...out.values()] : null;
}

/**
 * `changes`, a deletion and any text written in its place, as one set that
 * leaves every construct it only partly covers reading as itself (RICH-02,
 * RICH-18): first `hug`s whitespace out of the marks it would stand against,
 * then, when a change touches syntax or stands beside it, checks the text
 * blocks it touches against a fresh parse (`broken`). When the check fails,
 * `strict` gives null; otherwise each construct that no longer reads as
 * itself loses its marks and keeps its text, so no mark is ever left showing
 * as text. Typing at a caret, the common case, never comes here.
 */
function mend(state: EditorState, changes: readonly Change[], keep: boolean, strict: boolean): ChangeSet | null {
  const list = changes.map((c) => ({ ...c })).sort((a, b) => a.from - b.from);
  const moved = hug(state, list, keep);
  const set = state.changes(list);
  const { doc } = state;
  const parser = state.facet(language)?.parser;
  const touchy = (c: Change) => SPECIAL.test(doc.sliceString(Math.max(0, c.from - 1), c.from) + doc.sliceString(c.to, c.to + 1) + (c.insert ?? "")
    + (c.to - c.from > 500 ? "*" : doc.sliceString(c.from, c.to)));
  if (!parser || (!moved && !changes.some(touchy))) return set;
  // The text blocks at each end of each change; from a blank line, the nearest above and below, which the change may join.
  const blocks: Region[] = [];
  const add = (pos: number) => {
    const b = textBlock(state, pos);
    if (b && !blocks.some((x) => x.from === b.from)) blocks.push(b);
  };
  for (const c of list) {
    for (const pos of [c.from, c.to]) {
      const line = doc.lineAt(pos);
      if (!BLANK.test(line.text)) { add(pos); continue; }
      let above = line.number;
      while (above > 1 && BLANK.test(doc.line(above - 1).text)) above--;
      if (above > 1) add(doc.line(above - 1).to);
      let below = line.number;
      while (below < doc.lines && BLANK.test(doc.line(below + 1).text)) below++;
      if (below < doc.lines) add(doc.line(below + 1).from);
    }
  }
  if (!blocks.length) return set;
  blocks.sort((a, b) => a.from - b.from);
  const tree = syntaxTree(state);
  const before = blocks.map((b) => reading(doc, b, parser, tree));
  const first = broken(state, parser, blocks, before, set, []);
  if (!first) return set;
  if (strict) return null;
  // A construct whose marks `hug` moved goes back to the changes as given.
  const touched = (s: Span) => list.some((c) => c.from < c.to && ((c.from < s.cf && c.to > s.from) || (c.from < s.to && c.to > s.ct)));
  const base = first.some(touched) ? [...changes].sort((a, b) => a.from - b.from) : list;
  const gone: Span[] = [];
  let out = base === list ? set : state.changes(base);
  for (let round = 0; round < 3; round++) {
    const bad = (round || base !== list ? broken(state, parser, blocks, before, out, gone) : first)?.filter((s) => !gone.some((g) => g.from === s.from));
    if (!bad?.length) break;
    gone.push(...bad);
    out = state.changes([...base, ...gone.flatMap((s) => [{ from: s.from, to: s.cf }, { from: s.ct, to: s.to }])]);
  }
  return out;
}

/** `changes` written so that every construct they only partly cover still reads as itself; see `mend`. */
export function mended(state: EditorState, changes: readonly Change[], keep = false): ChangeSet {
  return mend(state, changes, keep, false)!;
}

/** `changes`, with whitespace taken out of the marks, when a fresh parse finds every construct they partly cover whole; null otherwise. */
export function intact(state: EditorState, changes: readonly Change[]): ChangeSet | null {
  return mend(state, changes, false, true);
}

/**
 * Text dropped at `pos`, carried with the syntax of the constructs it was
 * dragged out of, less the syntax of those `pos` already stands inside: `**and**`
 * dropped into bold lands as `and`, and takes the bold it lands in. Inside a
 * code span, which holds no syntax, and with `plain`, it lands as its visible
 * text alone. Text holding a line break lands as it is, as `pasted` writes it.
 */
export function landing(state: EditorState, pos: number, text: string, plain = false): string {
  const parser = state.facet(language)?.parser;
  if (!parser || text.includes("\n")) return text;
  const around = [...spansAt(state, pos, -1), ...spansAt(state, pos, 1)].filter((s) => s.cf <= pos && pos <= s.ct);
  if (!around.length && !plain) return text;
  const r = read(parser, text, NBSP);
  const cut = plain || around.some((s) => s.name === "InlineCode" || s.name === "Autolink") ? r.hidden : new Uint8Array(text.length);
  if (cut !== r.hidden) {
    for (const o of r.spans) {
      if (o.name !== "Image" && around.some((s) => s.name === o.name)) { cut.fill(1, o.from, o.cf); cut.fill(1, o.ct, o.to); }
    }
  }
  let out = "";
  for (let i = 0; i < text.length; i++) if (!cut[i]) out += text[i];
  return out;
}

/**
 * The range that text typed or pasted over the selection `from`–`to`
 * replaces. The start moves past a line's block marks, so the new text keeps
 * the block's style, and the end back before hidden line breaks. A selection
 * of whole lines, as a triple click makes one, keeps the line break after its
 * last line, so the next paragraph does not join the text typed. Inline marks
 * stay where the selection puts them: a paste that writes the selection's
 * source back, as a link around it, needs them inside or outside it whole.
 */
export function typedRange(state: EditorState, lay: Layout, from: number, to: number): { from: number; to: number } {
  const ahead = (pos: number) => {
    for (const p of runAt(state, lay, pos).pieces) if (p.block && p.from <= pos && p.to > pos) pos = p.to;
    return pos;
  };
  const back = (pos: number) => {
    const { pieces } = runAt(state, lay, pos);
    for (let i = pieces.length - 1; i >= 0; i--) if (pieces[i].merge && pieces[i].from < pos && pieces[i].to >= pos) pos = pieces[i].from;
    return pos;
  };
  const start = ahead(from);
  let end = back(to);
  if (end > start && end === state.doc.lineAt(end).from && runAt(state, lay, start).from <= state.doc.lineAt(start).from) {
    const u = step(state, lay, end, false);
    if (u && u.char === "\n" && !u.blocks && u.from >= start) end = back(u.from);
  }
  return { from: start, to: Math.max(start, end) };
}

/**
 * Where a paragraph break written at `pos` goes, and the formatting it closes
 * before it and reopens after it. It goes past closing marks right after
 * `pos`, so the text before keeps them, or else before opening marks right
 * before it; and out of an autolink, which cut in two is two pieces of text,
 * to the autolink's nearer edge.
 */
function breakAt(state: EditorState, pos: number): { at: number; closes: string; opens: string } {
  let at = pos;
  const auto = spansAt(state, at, 1).find((s) => s.name === "Autolink" && s.cf < at && at < s.ct);
  if (auto) at = at - auto.cf < auto.ct - at ? auto.from : auto.to;
  let right = at;
  for (let moved = true; moved; ) {
    moved = false;
    for (const s of spansAt(state, right, -1)) if (s.ct === right) { right = s.to; moved = true; }
  }
  if (right > at) at = right;
  else {
    for (let moved = true; moved; ) {
      moved = false;
      for (const s of spansAt(state, at, 1)) if (s.cf === at) { at = s.from; moved = true; }
    }
  }
  const inside = spansAt(state, at, 1).filter((s) => s.cf < at && at < s.ct);
  return {
    at,
    closes: inside.map((s) => state.doc.sliceString(s.ct, s.to)).join(""),
    opens: inside.slice().reverse().map((s) => state.doc.sliceString(s.from, s.cf)).join(""),
  };
}

/**
 * Text pasted or dropped at `pos`, written so that the formatting around it
 * survives: text holding a line break closes the formatting `pos` falls
 * inside before its first line break and reopens it after its last, as Enter
 * splits it (RICH-19). A table cell writes its own line breaks (`cellText`).
 */
export function pasted(state: EditorState, pos: number, text: string): { at: number; insert: string } {
  const first = text.indexOf("\n");
  if (first < 0 || tableRow(state, pos)) return { at: pos, insert: text };
  const { at, closes, opens } = breakAt(state, pos);
  const last = text.lastIndexOf("\n");
  return { at, insert: text.slice(0, first) + closes + text.slice(first, last + 1) + opens + text.slice(last + 1) };
}

export interface Edit { changes: ChangeSpec; range: SelectionRange }

const LEAF = /^(Paragraph|ATXHeading\d|SetextHeading\d|HorizontalRule|Task|FencedCode|CodeBlock|HTMLBlock|CommentBlock|ProcessingInstructionBlock|LinkReference|Table|Frontmatter)$/;
/** Blocks whose text Delete may join onto the end of another's, taking its formatting. */
const JOINABLE = /^(Paragraph|ATXHeading\d|Task)$/;

/**
 * Backspace, or Delete with `forward`: one visible character, one object, or
 * a line break, with Ctrl a word (`group`). Backspace on an empty paragraph
 * removes it and the blank line before it. Backspace at the start of any
 * other block is RICH-07's, bound ahead of this in `format.ts`: here it joins
 * only the lines of one paragraph. Delete at a paragraph's end joins the next
 * paragraph or heading onto it, blank lines and marks and all. A widget — a
 * code block's fence, frontmatter — is never deleted by a key, and neither is
 * a table's pipe or the line break between its rows. What goes is written as
 * `mended` gives it, so no construct's marks are left showing. Null means
 * there is nothing here to delete.
 */
export function deleteBy(state: EditorState, lay: Layout, range: SelectionRange, forward: boolean, group: boolean): Edit | null {
  const { doc } = state;
  if (!range.empty) {
    const del = deletion(state, range.from, range.to);
    const set = mended(state, del);
    return { changes: set, range: EditorSelection.cursor(set.mapPos(del.length ? del[0].from : range.from, -1)) };
  }
  const pos = range.head;
  const line = doc.lineAt(pos);
  const u = step(state, lay, pos, forward);
  if (!u || u.blocks || u.char === "\t") return null;
  if (u.char === "\n" && (tableRow(state, u.from) || tableRow(state, u.to))) return null;
  let { from, to } = u;
  if (u.char === "\n") {
    // A line break goes with the hidden blank lines beside it.
    const empty = BLANK.test(line.text);
    if (forward) {
      from = runAt(state, lay, pos).pieces.find((p) => p.merge)?.from ?? from;
      const here = leafBlock(state, pos);
      const next = leafBlock(state, to);
      if (here && next && here.from !== next.from && !(JOINABLE.test(here.name) && JOINABLE.test(next.name))) return null;
      // An empty paragraph goes whole, and the block after it keeps its marks;
      // otherwise the next line's marks have no place in the middle of this one.
      if (empty) return { changes: { from: line.from, to }, range: EditorSelection.cursor(canonical(state, lay, to, 1).head - (to - line.from)) };
      const after = runAt(state, lay, to);
      if (after.from === to) for (const p of after.pieces) if (p.block) to = Math.max(to, p.to);
    } else {
      for (let m = mergeOver(lay, from); m; m = mergeOver(lay, from)) from = m.from;
      const here = leafBlock(state, pos);
      if (!empty && (!here || here.from > from)) return null;
      // An empty paragraph goes whole; a line of a paragraph loses its indentation as it joins the one above.
      to = empty ? line.to : pos;
    }
  } else if (group) {
    // Ctrl takes a word, never a line break with it, as the source view does.
    const edge = wordEdge(state, lay, pos, forward, false);
    if (forward) to = edge;
    else from = edge;
  }
  const del = deletion(state, from, to);
  if (!del.length) return null;
  // One character goes alone: whitespace it leaves against a mark stays, and the mark moves in over it.
  const set = mended(state, del, !group && u.char !== "\n");
  return { changes: set, range: EditorSelection.cursor(set.mapPos(pos, forward ? 1 : -1)) };
}

/** The block holding `pos`: a paragraph, a heading, a code block and so on. */
function leafBlock(state: EditorState, pos: number): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (LEAF.test(n.name) && n.from <= pos && n.to >= pos) return n;
    }
  }
  return null;
}

/** What a new line of `line`'s block starts with to stay inside the same quote and list item. */
function continuation(state: EditorState, line: Line, lay: Layout): string {
  let out = "";
  for (const p of lineSyntax(state, line, lay).pieces) {
    if (!p.block || p.from !== line.from + out.length) break;
    const text = state.doc.sliceString(p.from, p.to);
    if (p.draw !== "task") out += BLANK.test(text) ? text : " ".repeat(text.length);
  }
  return out;
}

/**
 * Enter in a paragraph or heading (RICH-19). At the end it starts a new
 * paragraph with one blank line before it; in the middle it splits the block,
 * closing and reopening any formatting the split falls inside (`breakAt`),
 * and a split heading stays a heading on both sides; at the start of a line
 * inside a paragraph, the line break before it becomes the paragraph break;
 * at the start of the block it opens an empty paragraph above. Whitespace at
 * the cut goes, and the second half never opens another block: indentation
 * that would make it code goes, a mark that would open a list, a link
 * definition or HTML is escaped, and a split nothing else saves is a hard
 * break. In an empty paragraph it writes nothing, since Markdown
 * holds no empty paragraphs. On the first line of a fence still being typed it
 * closes the code block and puts the caret inside. Null leaves the key to the
 * editor: in code, in a source box, in a list or a quote. A table's Enter is
 * `rowMove`.
 */
export function enter(state: EditorState, lay: Layout, range: SelectionRange): Edit | null {
  if (!range.empty) return null;
  const { doc } = state;
  const pos = range.head;
  const line = doc.lineAt(pos);
  const block = leafBlock(state, pos);
  const fence = unclosedFence(state, line);
  if (fence) {
    // At the document's end a line follows the closing fence, so the caret
    // has somewhere to go below the block.
    const mark = fence.getChild("CodeMark");
    const indent = /^\s*/.exec(line.text)![0];
    const insert = `\n${indent}\n${indent}${mark ? doc.sliceString(mark.from, mark.to) : "```"}${line.to === doc.length ? "\n" : ""}`;
    return { changes: { from: line.to, insert }, range: EditorSelection.cursor(line.to + 1 + indent.length) };
  }
  if (block && (BOX.has(block.name) || block.name === "Table" || isFootnote(state, block))) return null;
  if (BLANK.test(line.text) && (!block || block.from > pos || block.to < pos)) return { changes: [], range };
  if (!block || block.parent?.name !== "Document" || block.name === "Task") return null;
  const first = doc.lineAt(block.from);
  const run = runAt(state, lay, pos);
  if (run.to >= doc.lineAt(block.to).to || pos === block.to) {
    const next = block.to < doc.length ? doc.lineAt(block.to + 1) : null;
    const insert = next && !BLANK.test(next.text) ? "\n\n\n" : "\n\n";
    return { changes: { from: block.to, insert }, range: EditorSelection.cursor(block.to + 2) };
  }
  if (line.number === first.number && run.from <= line.from) {
    const prevBlank = first.number > 1 && BLANK.test(doc.line(first.number - 1).text);
    const extra = first.number > 1 && !prevBlank ? "\n" : "";
    return { changes: { from: first.from, insert: `${extra}\n\n` }, range: EditorSelection.cursor(first.from + extra.length) };
  }
  const { at, closes, opens } = breakAt(state, pos);
  const heading = /^ATXHeading/.test(block.name) ? doc.sliceString(first.from, runAt(state, lay, first.from).pieces.find((p) => p.block)?.to ?? first.from) : "";
  // A setext heading's first half takes a copy of its underline, which is what makes it a heading of its level.
  const mark = /^SetextHeading/.test(block.name) ? block.lastChild : null;
  const underline = mark?.name === "HeaderMark" ? `\n${doc.sliceString(mark.from, mark.to)}` : "";
  const cut = doc.lineAt(at);
  const here = runAt(state, lay, at);
  // Whitespace ending the first half or starting the second shows nothing
  // there, and beside a closing or opening mark keeps the mark from pairing: it goes.
  const back = (pos: number, floor: number) => { while (pos > floor && SPACE.test(doc.sliceString(pos - 1, pos))) pos--; return pos; };
  const ahead = (pos: number, ceiling: number) => { while (pos < ceiling && SPACE.test(doc.sliceString(pos, pos + 1))) pos++; return pos; };
  // The changes, the caret, and where the second half's text starts.
  let changes: Change[];
  let caret: number;
  let rest: number;
  if (here.to >= cut.to && cut.to < block.to) {
    // At the end of a line inside the paragraph: the lines below become a
    // paragraph of their own, and a hard break ending this line goes.
    const from = back(at, cut.from);
    const next = doc.line(cut.number + 1);
    rest = ahead(next.from, next.to);
    changes = [{ from, to: cut.to, insert: `${closes}${underline}\n\n` }, { from: next.from, to: rest, insert: `\n${opens}` }];
    caret = from + closes.length + underline.length + 2;
  } else if (cut.from > block.from && here.from <= cut.from) {
    // At the start of a line inside the paragraph: the line break before it
    // becomes the paragraph break, and a hard break ending the line above goes.
    const above = doc.line(cut.number - 1);
    const hard = syntaxTree(state).resolveInner(above.to, -1);
    const indent = ahead(cut.from, cut.to);
    const start = at <= indent ? cut.from : at;
    rest = Math.max(at, indent);
    changes = [
      { from: hard.name === "HardBreak" ? hard.from : back(above.to, above.from), to: above.to, insert: `${closes}${underline}\n` },
      { from: start, to: rest, insert: opens },
    ];
    caret = state.changes(changes).mapPos(start, -1) + opens.length;
  } else {
    const insert = `${closes}${underline}\n\n${heading}${opens}`;
    const from = back(at, cut.from);
    rest = ahead(at, cut.to);
    changes = [{ from, to: rest, insert }];
    caret = from + insert.length;
  }
  // The second half starts a block, where its first line may read as a list
  // item, a code block or a link definition, which inside the paragraph it did
  // not: its first character is escaped. Failing that the break is a hard one,
  // whose new line is escaped alike; and failing that Enter writes nothing.
  const parser = state.facet(language)?.parser;
  if (parser && !opens && !heading) {
    const shape = (list: Change[]) => {
      const set = state.changes(list);
      const names: string[] = [];
      parser.parse(set.apply(doc).sliceString(block.from, set.mapPos(block.to, 1))).iterate({
        enter: (n) => { if (n.name === "Document") return true; names.push(n.name); return false; },
      });
      return names.join(" ");
    };
    const escape = (pos: number): Change[] => {
      const text = doc.sliceString(pos, doc.lineAt(pos).to);
      const digits = /^\d{1,9}(?=[.)])/.exec(text)?.[0].length ?? 0;
      return digits || /^[!-/:-@[-`{-~]/.test(text) ? [{ from: pos + digits, to: pos + digits, insert: "\\" }] : [];
    };
    if (shape(changes) !== `${block.name} ${block.name}`) {
      const escaped = [...changes, ...escape(rest)];
      if (shape(escaped) === `${block.name} ${block.name}`) return { changes: escaped, range: EditorSelection.cursor(caret) };
      const hard = block.name === "Paragraph" ? hardBreak(state, lay, range) : null;
      const { from, insert } = (hard?.changes ?? {}) as { from?: number; insert?: string };
      if (from === undefined || insert === undefined) return { changes: [], range };
      const start = ahead(from, doc.lineAt(from).to);
      const broken = [{ from, to: start, insert }, ...escape(start)];
      return shape(broken) === block.name ? { changes: broken, range: EditorSelection.cursor(from + insert.length) } : { changes: [], range };
    }
  }
  return { changes, range: EditorSelection.cursor(caret) };
}

/**
 * Shift+Enter: a hard line break inside the paragraph, written as a trailing
 * backslash, with the new line indented to stay in its quote or list item.
 * In a heading, which cannot hold one, it is Enter.
 */
export function hardBreak(state: EditorState, lay: Layout, range: SelectionRange): Edit | null {
  if (!range.empty) return null;
  const { doc } = state;
  const pos = range.head;
  const block = leafBlock(state, pos);
  if (!block) return null;
  if (/^(ATX|Setext)Heading/.test(block.name)) return enter(state, lay, range);
  if ((block.name !== "Paragraph" && block.name !== "Task") || isFootnote(state, block)) return null;
  const line = doc.lineAt(pos);
  const run = runAt(state, lay, pos);
  // The break goes past closing marks, which cannot open a line, and before
  // opening ones, which cannot end one.
  let at = pos;
  if (run.to >= line.to) at = line.to;
  else if (run.from <= line.from) at = Math.max(line.from, ...run.pieces.filter((p) => p.block).map((p) => p.to));
  else for (const p of run.pieces) if (p.from === at && !p.open && !p.glue && !p.merge) at = p.to;
  const insert = `\\\n${continuation(state, line, lay)}`;
  return { changes: { from: at, insert }, range: EditorSelection.cursor(at + insert.length) };
}

/**
 * Text typed on an empty line straight after a list item or a quote would be
 * read as more of it; a blank line first makes it the new paragraph it looks
 * like. Null when no blank line is needed.
 */
export function paragraphBreakBefore(state: EditorState, pos: number): string | null {
  const { doc } = state;
  const line = doc.lineAt(pos);
  if (line.text !== "" || line.number === 1) return null;
  const prev = doc.line(line.number - 1);
  if (BLANK.test(prev.text)) return null;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(prev.to, -1); n; n = n.parent) {
    if (n.name === "ListItem" || n.name === "Blockquote") return "\n";
  }
  return null;
}

// --- Tables (RICH-11) ---------------------------------------------------------

/**
 * A table row as the rendered view edits it: one line, whose cells are text
 * and whose pipes, with the spaces around each cell, are hidden syntax
 * (`separators`). An empty cell's text is the first space between its pipes,
 * or the empty range there when there is none. A row longer than the header
 * keeps only the header's width of cells, as GFM reads it.
 */
export interface Row {
  /** The header row, as against a body row. */
  head: boolean;
  /** The row's line. */
  from: number;
  to: number;
  node: SyntaxNode;
  cells: { from: number; to: number }[];
}

/** Each cell's text in a row node, in column order. */
function cellRanges(state: EditorState, node: SyntaxNode): { from: number; to: number }[] {
  const cells: { from: number; to: number }[] = [];
  let cell: SyntaxNode | null = null;
  let leading = true;
  let prev = node.from;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableCell") cell = c;
    else if (c.name === "TableDelimiter") {
      if (cell) cells.push({ from: cell.from, to: cell.to });
      else if (!leading) cells.push({ from: prev, to: Math.min(c.from, prev + (state.doc.sliceString(prev, prev + 1) === " " ? 1 : 0)) });
      cell = null;
      prev = c.to;
    }
    leading = false;
  }
  if (cell) cells.push({ from: cell.from, to: cell.to });
  return cells;
}

function rowOf(state: EditorState, node: SyntaxNode, line: { from: number; to: number }): Row {
  const header = node.parent?.firstChild;
  const columns = header && header.name === "TableHeader" && header.from !== node.from ? cellRanges(state, header).length : Infinity;
  return { head: node.name === "TableHeader", from: line.from, to: line.to, node, cells: cellRanges(state, node).slice(0, columns) };
}

/** The table row on the line holding `pos`, or null when that line is not one. */
export function tableRow(state: EditorState, pos: number): Row | null {
  const line = state.doc.lineAt(pos);
  let row = null as Row | null;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(n) {
      if (row) return false;
      if (ROW.test(n.name)) {
        if (n.from >= line.from && n.to <= line.to) row = rowOf(state, n.node, line);
        return false;
      }
      return n.name === "Table" || CONTAINERS.has(n.name);
    },
  });
  return row;
}

/** A row's hidden syntax: before its first cell, between each two cells, and after its last. */
export function separators(row: Row): { from: number; to: number }[] {
  const { cells } = row;
  if (!cells.length) return [{ from: row.from, to: row.to }];
  return [
    { from: row.from, to: cells[0].from },
    ...cells.slice(1).map((c, i) => ({ from: cells[i].to, to: c.from })),
    { from: cells[cells.length - 1].to, to: row.to },
  ];
}

/**
 * The spaces after a cell's text and before the pipe that ends it, when
 * `pos` is among them past the text's end: spaces typed at the end of a cell,
 * which the cell reads as its own only once a word follows them. The caret
 * stands there, and the rendered view draws them in the cell while it does.
 */
export function cellTail(state: EditorState, row: Row, pos: number): { column: number; from: number; to: number } | null {
  for (let column = 0; column < row.cells.length; column++) {
    const from = row.cells[column].to;
    if (pos <= from) return null;
    let to = from;
    while (to < row.to && /[ \t]/.test(state.doc.sliceString(to, to + 1))) to++;
    if (pos <= to) return { column, from, to };
  }
  return null;
}

/**
 * What a deletion from `from` to `to` keeps of a table it does not take
 * whole: every separator whose pipe it reaches, the delimiter row, the line
 * breaks between rows, and the blank lines between the table and any text
 * the deletion reaches outside it, so what is left is still the same table.
 */
function tableSyntax(state: EditorState, table: SyntaxNode, from: number, to: number): { from: number; to: number }[] {
  const { doc } = state;
  const first = doc.lineAt(table.from);
  const last = doc.lineAt(table.to);
  if (from <= first.from && to >= last.to) return [];
  const out: { from: number; to: number }[] = [];
  const keep = (a: number, b: number) => {
    if (Math.min(b, to) > Math.max(a, from)) out.push({ from: Math.max(a, from), to: Math.min(b, to) });
  };
  let before = first.from;
  while (before > 0 && /\s/.test(doc.sliceString(before - 1, before))) before--;
  keep(before, first.from);
  let after = last.to;
  while (after < doc.length && /\s/.test(doc.sliceString(after, after + 1))) after++;
  keep(last.to, after);
  for (let n = doc.lineAt(Math.max(from, first.from)).number, end = doc.lineAt(Math.min(to, last.to)).number; n <= end; n++) {
    const line = doc.line(n);
    const row = tableRow(state, line.from);
    if (!row) keep(line.from, line.to);
    // A separator is kept whole when the deletion reaches its pipe; spaces alone are a cell's tail, and go.
    for (const s of row ? separators(row) : []) {
      const pipe = s.from + doc.sliceString(s.from, s.to).indexOf("|");
      if (pipe >= s.from && pipe >= from && pipe < to) keep(s.from, s.to);
    }
    if (n < last.number) keep(line.to, line.to + 1);
  }
  return out;
}

/**
 * What a deletion from `from` to `to` keeps of a code block or frontmatter it
 * does not take whole: each fence line, the line break joining it to the
 * block's text, and the blank lines between it and any text the deletion
 * code. When the deletion starts before the block's text, the line of it the
 * deletion ends in keeps the list indentation or quote marks that hold it
 * inside the block's container.
 */
function fenceSyntax(state: EditorState, block: SyntaxNode, from: number, to: number): { from: number; to: number }[] {
  const { doc } = state;
  const open = doc.lineAt(block.from);
  const marks = block.getChildren(block.name === "Frontmatter" ? "FrontmatterMark" : "CodeMark");
  const last = marks[marks.length - 1];
  const close = marks.length > 1 && last.from > open.to ? doc.lineAt(last.from) : null;
  const end = close ?? doc.lineAt(block.to);
  if (from <= open.from && to >= end.to) return [];
  const out: { from: number; to: number }[] = [];
  const keep = (a: number, b: number) => {
    if (Math.min(b, to) > Math.max(a, from)) out.push({ from: Math.max(a, from), to: Math.min(b, to) });
  };
  let before = open.number;
  while (before > 1 && BLANK.test(doc.line(before - 1).text)) before--;
  keep(before > 1 ? doc.line(before).from - 1 : 0, Math.min(open.to + 1, doc.length));
  const inner = doc.lineAt(to);
  if (from <= open.to && inner.number > open.number && (close ? inner.number < close.number : inner.number <= end.number)) {
    const indent = Math.min(block.from - open.from, /^[\s>]*/.exec(inner.text)![0].length);
    keep(inner.from, inner.from + indent);
  }
  if (close) {
    let after = close.number;
    while (after < doc.lines && BLANK.test(doc.line(after + 1).text)) after++;
    keep(close.from - 1, after < doc.lines ? doc.line(after).to + 1 : doc.length);
  }
  return out;
}

/**
 * The cell holding `pos`, in its text or its tail: its row, and its column. A
 * position inside the pipe between two cells is the second one's.
 */
export function cellAt(state: EditorState, pos: number): { row: Row; column: number } | null {
  const row = tableRow(state, pos);
  if (!row || !row.cells.length) return null;
  const column = cellTail(state, row, pos)?.column ?? row.cells.findIndex((c) => pos <= c.to);
  return { row, column: column < 0 ? row.cells.length - 1 : column };
}

/** The next row of `row`'s table, or the previous with `dir` -1, passing over the delimiter row. */
function nextRow(state: EditorState, row: Row, dir: 1 | -1): Row | null {
  for (let n = dir > 0 ? row.node.nextSibling : row.node.prevSibling; n; n = dir > 0 ? n.nextSibling : n.prevSibling) {
    if (ROW.test(n.name)) return rowOf(state, n, state.doc.lineAt(n.from));
  }
  return null;
}

/** The caret at the end of a cell's text, where typing adds to it. */
function cellEnd(state: EditorState, lay: Layout, row: Row, column: number): SelectionRange {
  const cell = row.cells[Math.max(0, Math.min(column, row.cells.length - 1))];
  return canonical(state, lay, cell ? cell.to : row.to, -1);
}

/**
 * Tab, or Shift+Tab with `dir` -1: the caret moves to the end of the next or
 * previous cell's text, on to the next or previous row past the end of one,
 * and stays where it is at the table's first and last cells. Null outside a
 * table.
 */
export function cellMove(state: EditorState, lay: Layout, range: SelectionRange, dir: 1 | -1): SelectionRange | null {
  const at = cellAt(state, range.head);
  if (!at) return null;
  const column = at.column + dir;
  if (column >= 0 && column < at.row.cells.length) return cellEnd(state, lay, at.row, column);
  const next = nextRow(state, at.row, dir);
  return next ? cellEnd(state, lay, next, dir > 0 ? 0 : next.cells.length - 1) : range;
}

/**
 * Enter in a table: the caret moves to the end of the same column's text in
 * the next row. On the last row it leaves the table for the line below it,
 * and stays where it is when the document ends there. Null outside a table.
 */
export function rowMove(state: EditorState, lay: Layout, range: SelectionRange): SelectionRange | null {
  const at = cellAt(state, range.head);
  if (!at) return null;
  const next = nextRow(state, at.row, 1);
  if (next) return cellEnd(state, lay, next, at.column);
  const below = step(state, lay, at.row.cells[at.row.cells.length - 1].to, true);
  return below ? canonical(state, lay, below.to, 1) : range;
}

/**
 * Home, or End with `forward`: the caret moves to the start or the end of its
 * cell's text, and with `extend` the selection grows to it. Null outside a
 * table.
 */
export function cellEdge(state: EditorState, lay: Layout, range: SelectionRange, forward: boolean, extend: boolean): SelectionRange | null {
  const at = cellAt(state, range.head);
  if (!at) return null;
  const cell = at.row.cells[at.column];
  const to = canonical(state, lay, forward ? cell.to : cell.from, forward ? -1 : 1);
  return extend ? EditorSelection.range(range.anchor, to.head) : to;
}

/**
 * Shift+Enter in a table cell: a line break inside the cell, written as
 * `<br>` (ED-49), since a row is one line. A selection goes first, as
 * `deletion` takes it. Null outside a table, and when the break would land
 * outside one: a selection from a paragraph into a table.
 */
export function cellBreak(state: EditorState, range: SelectionRange): Edit | null {
  if (!cellAt(state, range.head)) return null;
  const del = range.empty ? [] : deletion(state, range.from, range.to);
  const at = del.length ? del[0].from : range.from;
  if (!cellAt(state, at)) return null;
  const set = mended(state, del.length ? del.map((d, i) => ({ ...d, insert: i ? "" : "<br>" })) : [{ from: at, to: at, insert: "<br>" }]);
  return { changes: set, range: EditorSelection.cursor(set.mapPos(at, -1) + 4) };
}

/**
 * `text`, written into a table cell as the cell can hold it: a line break is
 * `<br>` (ED-49), since a row is one line, and a pipe is escaped so it does
 * not split the cell. `before` is the cell's text before the insertion, whose
 * backslashes may already escape a pipe at `text`'s start, and `next` the
 * character after it: a backslash left just before a pipe is escaped itself.
 */
export function cellText(before: string, text: string, next: string): string {
  let out = "";
  let slashes = /\\*$/.exec(before)![0].length;
  for (const ch of text.replace(/\r\n?|\n/g, "<br>")) {
    if (ch === "|" && slashes % 2 === 0) out += "\\";
    out += ch;
    slashes = ch === "\\" ? slashes + 1 : 0;
  }
  return next === "|" && slashes % 2 === 1 ? `${out}\\` : out;
}
