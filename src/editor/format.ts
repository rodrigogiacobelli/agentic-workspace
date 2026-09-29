// The formatting commands of rich mode: bold, italic, strikethrough and inline
// code, paragraph styles, lists, checklists, quotes, code blocks and links
// (RICH-04 to RICH-07, RICH-09). Each is a function from an editor state to
// the transaction that writes the Markdown for it, found by reading the
// document's own syntax tree. A transaction writes the syntax of the
// construct it formats and only what else that syntax needs to read as
// meant — a backslash, a blank line, a mark closed and reopened — and never
// changes visible text anywhere else (ADR-003, RICH-18). It is isolated in
// the history so one undo takes back one command. A formatting command
// checks what it writes against a fresh parse and refuses what the parser
// would read otherwise (`checked`, `blockChecked`). Copying and dragging
// build their text here too (RICH-17). What calls these — the keys, the
// toolbar, the link popover — is `toolbar.ts`; this module stays free of
// the page so it can be tested.

import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, language, syntaxTree } from "@codemirror/language";
import {
  ChangeSet, CharCategory, EditorSelection, StateEffect, StateField,
  type ChangeSpec, type EditorState, type Line, type SelectionRange, type Text, type TransactionSpec,
} from "@codemirror/state";
import { type ChangedRange, IterMode, type NodeType, type Parser, type SyntaxNode, type SyntaxNodeRef, type Tree, TreeFragment } from "@lezer/common";
import { type Layout, type Unit, isFootnote, step } from "./rich.ts";

export type Mark = "strong" | "emphasis" | "strike" | "code";
export type ListKind = "bullet" | "ordered" | "task";

const NODE: Record<Mark, string> = { strong: "StrongEmphasis", emphasis: "Emphasis", strike: "Strikethrough", code: "InlineCode" };
/** What a new piece of formatting is written with (§7): existing text keeps whatever it has. */
const MARKER: Record<Mark, string> = { strong: "**", emphasis: "*", strike: "~~", code: "`" };
const MARKS: Mark[] = ["strong", "emphasis", "strike", "code"];

/** The syntax characters of an inline construct. */
const SYNTAX = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark", "LinkMark"]);
/** Inline constructs that hold no formatting inside them: a boundary that falls inside one moves to its edge. */
const ATOMIC = new Set(["InlineCode", "URL", "Autolink", "HTMLTag", "Citation", "Escape", "Entity", "Image", "Comment", "ProcessingInstruction", "HardBreak", "LinkTitle", "LinkLabel"]);
/** Where character formatting can go. */
const INLINE_CONTAINER = /^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|Task|TableCell)$/;
/** Blocks that are not prose: paragraph styles and lists leave them alone. */
const NOT_PROSE = /^(FencedCode|CodeBlock|HTMLBlock|Frontmatter|LinkReference|CommentBlock|ProcessingInstructionBlock|HorizontalRule|Table)$/;
/** A block holding one run of text. */
const TEXTBLOCK = /^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|Task)$/;
/** What a continuation line of a text block starts with before its text: indentation and quote marks. */
const LEAD = /^[ \t]*(?:>[ \t]?)*[ \t]*/;

interface Span { from: number; to: number }
/** One change of a command's, against the document before it. */
interface Change { from: number; to?: number; insert?: string }
/** A construct inside a run of formatting, which a cut goes around; a blank one — a quote's `>`, a marker being deleted — counts as whitespace. */
interface Part extends Span { blank: boolean }

/**
 * The tree for the whole document when it can be had quickly, and whatever is
 * parsed otherwise; the view keeps the part on screen parsed.
 */
function treeOf(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
}

const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

function trim(doc: Text, from: number, to: number): Span {
  const text = doc.sliceString(from, to);
  let a = 0;
  let b = text.length;
  while (a < b && isSpace(text[a])) a++;
  while (b > a && isSpace(text[b - 1])) b--;
  return { from: from + a, to: from + b };
}

const isPunct = (ch: string) => /[\p{P}\p{S}]/u.test(ch);
const isWordish = (ch: string) => ch !== "" && !isSpace(ch) && !isPunct(ch);

/**
 * Whether a delimiter run of `ch` between the characters `before` and `after`
 * can open (`open`) or close emphasis or strikethrough, by CommonMark's
 * flanking rules as the parser applies them: the start or end of the text
 * reads as whitespace, and `_` opens or closes inside a word only where
 * punctuation lets it.
 */
function canFlank(ch: string, before: string, after: string, open: boolean): boolean {
  const sBefore = /\s|^$/.test(before);
  const sAfter = /\s|^$/.test(after);
  const pBefore = isPunct(before);
  const pAfter = isPunct(after);
  const left = !sAfter && (!pAfter || sBefore || pBefore);
  const right = !sBefore && (!pBefore || sAfter || pAfter);
  if (ch === "_") return open ? left && (!right || pBefore) : right && (!left || pAfter);
  return open ? left : right;
}

/** `p` moved past the blank parts beside it: back past those ending there for -1, on past those starting there for 1. */
function past(parts: readonly Part[], p: number, dir: -1 | 1): number {
  for (let b = parts.find((x) => x.blank && (dir < 0 ? x.to : x.from) === p); b; b = parts.find((x) => x.blank && (dir < 0 ? x.to : x.from) === p)) {
    p = dir < 0 ? b.from : b.to;
  }
  return p;
}

/** The character beside `p`, before it for -1 and after it for 1, read past blank parts. */
function near(doc: Text, parts: readonly Part[], p: number, dir: -1 | 1): string {
  const at = past(parts, p, dir) + (dir < 0 ? -1 : 0);
  return at < 0 || at >= doc.length ? "" : doc.sliceString(at, at + 1);
}

/**
 * `span` trimmed until emphasis markers written at its ends can open and
 * close: CommonMark lets no `*` or `~` run open before punctuation that
 * follows a letter, or close after punctuation that precedes one, so that
 * punctuation stays outside. `parts` are the constructs inside the span: each
 * stays in or goes out whole, so no end lands inside one, and a blank part
 * goes as whitespace does. `cut` is the one end a marker is written at when
 * the other end is a run's own marker, -1 the start and 1 the end, with the
 * characters that marker is written in. A marker joins the delimiter run of
 * its character beside it, so the flanking there is read past that run; and
 * the end moves off a `*`, `_` or `~` that is plain text, whose meaning a
 * marker beside it would change, and from between two backticks.
 */
function flank(doc: Text, span: Span, parts: readonly Part[] = [], cut?: { end: -1 | 1; marker: string }): Span {
  const beside = (p: number, dir: -1 | 1) => near(doc, parts, p, dir);
  const around = (p: number, dir: -1 | 1, end: -1 | 1) => {
    let ch = beside(p, dir);
    while (cut?.end === end && ch !== "" && cut.marker.includes(ch)) {
      p = past(parts, p, dir) + dir;
      ch = beside(p, dir);
    }
    return ch;
  };
  const loose = (p: number, dir: -1 | 1) => {
    const q = past(parts, p, dir);
    return /^[*_~]$/.test(beside(p, dir)) && !parts.some((u) => !u.blank && (dir < 0 ? u.to : u.from) === q);
  };
  const unsafe = (p: number, end: -1 | 1) => cut?.end === end && (loose(p, -1) || loose(p, 1) || (beside(p, -1) === "`" && beside(p, 1) === "`"));
  let { from, to } = span;
  while (from < to) {
    ({ from, to } = trim(doc, from, to));
    const head = parts.find((u) => u.from <= from && from < u.to && (u.from < from || u.blank));
    const tail = parts.find((u) => u.from < to && to <= u.to && (to < u.to || u.blank));
    if (head) from = head.to;
    else if (tail) to = tail.from;
    else if ((isPunct(around(from, 1, -1)) && isWordish(around(from, -1, -1))) || unsafe(from, -1)) from = parts.find((u) => u.from === from)?.to ?? from + 1;
    else if ((isPunct(around(to, -1, 1)) && isWordish(around(to, 1, 1))) || unsafe(to, 1)) to = parts.find((u) => u.to === to)?.from ?? to - 1;
    else break;
  }
  return { from, to };
}

/** The change from `from` to `to`, narrowed to the characters that actually differ. */
function replace(doc: Text, from: number, to: number, insert: string): Change[] {
  const old = doc.sliceString(from, to);
  let a = 0;
  while (a < old.length && a < insert.length && old[a] === insert[a]) a++;
  let b = 0;
  while (b < old.length - a && b < insert.length - a && old[old.length - 1 - b] === insert[insert.length - 1 - b]) b++;
  if (a === old.length && a === insert.length) return [];
  return [{ from: from + a, to: to - b, insert: insert.slice(a, insert.length - b) }];
}

/**
 * The selection after `changes`, pulled towards the text: a caret where
 * syntax was inserted lands after it, and a selection keeps to the text it
 * held rather than taking in the markers written around it. Neither stops
 * between a backslash the changes wrote and the character it escapes.
 */
function inward(ranges: readonly SelectionRange[], mainIndex: number, changes: ChangeSet): EditorSelection {
  const escapes = new Set<number>();
  changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => { if (inserted.sliceString(inserted.length - 1) === "\\") escapes.add(toB); });
  const map = (pos: number, assoc: -1 | 1) => {
    const at = changes.mapPos(pos, assoc);
    return escapes.has(at) ? at - 1 : at;
  };
  return EditorSelection.create(ranges.map((r) => {
    if (r.empty) return EditorSelection.cursor(map(r.head, 1));
    const forward = r.head > r.anchor;
    return EditorSelection.range(map(r.anchor, forward ? 1 : -1), map(r.head, forward ? -1 : 1));
  }), mainIndex);
}

/** One command, one entry in the history: never joined with the typing on either side of it (RICH-18). */
function commit(state: EditorState, changes: ChangeSpec[] | ChangeSet, selection?: EditorSelection | SelectionRange): TransactionSpec | null {
  const set = changes instanceof ChangeSet ? changes : state.changes(changes);
  if (set.empty) return null;
  return {
    changes: set,
    selection: selection instanceof EditorSelection ? selection
      : selection ? EditorSelection.create([selection])
      : inward(state.selection.ranges, state.selection.mainIndex, set),
    annotations: isolateHistory.of("full"),
    userEvent: "input.format",
    scrollIntoView: true,
  };
}

// --- The syntax tree -----------------------------------------------------

/** The opening and closing syntax of emphasis, strikethrough or inline code. */
function delimiters(n: SyntaxNode): { open: Span; close: Span } | null {
  const first = n.firstChild;
  const last = n.lastChild;
  if (!first || !last || first.from === last.from || !SYNTAX.has(first.name) || !SYNTAX.has(last.name)) return null;
  return { open: { from: first.from, to: first.to }, close: { from: last.from, to: last.to } };
}

/** A link's `[`, `]` and destination. */
function linkParts(n: SyntaxNode, doc: Text): { open: SyntaxNode; close: SyntaxNode; url: SyntaxNode | null } | null {
  let open: SyntaxNode | null = null;
  let close: SyntaxNode | null = null;
  let url: SyntaxNode | null = null;
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c.name === "LinkMark") {
      const mark = doc.sliceString(c.from, c.to);
      if (mark === "[" && !open) open = c;
      else if (mark === "]" && !close) close = c;
    } else if (c.name === "URL" && close) url = c;
  }
  return open && close ? { open, close, url } : null;
}

/**
 * Where formatting may be written inside `n` without cutting it: the text of
 * emphasis or a link, the whole of a block, and nowhere in an atomic
 * construct such as a code span or a citation.
 */
function nestable(n: SyntaxNode, doc: Text): Span | null {
  if (ATOMIC.has(n.name) || SYNTAX.has(n.name)) return null;
  if (n.name === "Emphasis" || n.name === "StrongEmphasis" || n.name === "Strikethrough") {
    const d = delimiters(n);
    return d ? { from: d.open.to, to: d.close.from } : null;
  }
  if (n.name === "Link") {
    const p = linkParts(n, doc);
    return p ? { from: p.open.to, to: p.close.from } : null;
  }
  return { from: n.from, to: n.to };
}

/**
 * Whether `n`, a URL node, is the destination of the link or image holding
 * it, which follows its `(`, rather than a bare address in its text.
 * `slice` reads the text the tree was parsed from.
 */
function isDestination(n: SyntaxNode, slice: (from: number, to: number) => string): boolean {
  const prev = n.prevSibling;
  return n.name === "URL" && /^(Link|Image)$/.test(n.parent?.name ?? "") && prev?.name === "LinkMark" && slice(prev.from, prev.to) === "(";
}

/** The nodes named `name` over or touching `from`–`to`, in document order, outer first. */
function nodesNamed(tree: Tree, name: string, from: number, to: number): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  if (from === to) {
    // A point's nodes are the ancestors of the innermost node on either side
    // of it, found without walking the tree down to it.
    for (const side of [-1, 1] as const) {
      for (let n: SyntaxNode | null = tree.resolveInner(from, side); n; n = n.parent) {
        const node = n;
        if (node.name === name && !out.some((o) => o.from === node.from && o.to === node.to)) out.push(node);
      }
    }
    return out.sort((a, b) => a.from - b.from || b.to - a.to);
  }
  iterateAround(tree, from, to, (n) => { if (n.name === name && n.from <= to && n.to >= from) out.push(n.node); });
  return out;
}

/**
 * `tree.iterate` over `from`–`to`, which walks down from the top of the
 * tree on every call, started instead at the smallest node holding the
 * range with a character to spare either side: every node the range
 * overlaps or touches is that node, one inside it, or one of its ancestors,
 * which are entered first, outermost first.
 */
function iterateAround(tree: Tree, from: number, to: number, enter: (n: SyntaxNodeRef) => boolean | void): void {
  let scope = tree.resolve(from, 1);
  while (scope.parent && !(scope.from < from && scope.to > to)) scope = scope.parent;
  const above: SyntaxNode[] = [];
  for (let p = scope.parent; p; p = p.parent) above.unshift(p);
  for (const a of above) if (enter(a) === false) return;
  // Through the tree's balancing nodes, which `enter` never sees, so that
  // what the range misses is skipped a whole group at a time.
  const c = scope.cursor(IterMode.IncludeAnonymous);
  let depth = 0;
  for (;;) {
    if (c.from <= to && c.to >= from && (c.type.isAnonymous || enter(c) !== false) && c.firstChild()) {
      depth++;
      continue;
    }
    for (;;) {
      if (depth === 0) return;
      if (c.nextSibling()) break;
      c.parent();
      depth--;
    }
  }
}

function ancestor(tree: Tree, pos: number, name: string): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) if (n.name === name) return n;
  }
  return null;
}

/** Where a text block's own text starts and ends: past a heading's `#`s and a checklist item's box. */
function textOf(state: EditorState, n: SyntaxNode): Span {
  const doc = state.doc;
  let from = n.from;
  let to = n.to;
  if (n.name.startsWith("ATXHeading")) {
    const first = n.firstChild;
    const last = n.lastChild;
    if (first?.name === "HeaderMark") from = first.to;
    if (last?.name === "HeaderMark" && last.from > (first?.from ?? -1)) to = last.from;
  } else if (n.name.startsWith("SetextHeading")) {
    const underline = n.lastChild;
    if (underline?.name === "HeaderMark") to = doc.lineAt(underline.from).from - 1;
  } else if (n.name === "Task") {
    const box = n.firstChild;
    if (box?.name === "TaskMarker") from = box.to;
  }
  const t = trim(doc, from, Math.max(from, to));
  return t.from < t.to ? t : { from: t.from, to: t.from };
}

/**
 * The inline text `from`–`to` covers: one span for each line of each
 * paragraph, heading, checklist item or table cell it touches, without the
 * block syntax at the start of a line. Code, tables' pipes, frontmatter and
 * what rich mode shows as source (RICH-15) hold none.
 */
function inlineSpans(state: EditorState, tree: Tree, from: number, to: number): Span[] {
  const doc = state.doc;
  const spans: Span[] = [];
  tree.iterate({
    from, to,
    enter: (n) => {
      if (NOT_PROSE.test(n.name) && n.name !== "Table") return false;
      if (!INLINE_CONTAINER.test(n.name)) return;
      if (isFootnote(state, n)) return false;
      const text = textOf(state, n.node);
      for (let pos = text.from; pos <= text.to;) {
        const line = doc.lineAt(pos);
        // The first line starts where the block's text does; a continuation
        // line past its indentation and quote marks.
        const start = pos === text.from ? pos : line.from + LEAD.exec(line.text)![0].length;
        // A hard break's `\` ends the line's text; it is syntax.
        const end = line.to < text.to && tree.resolveInner(line.to, -1).name === "HardBreak" ? line.to - 1 : line.to;
        const a = Math.max(start, from);
        const b = Math.min(end, text.to, to);
        if (a < b) spans.push({ from: a, to: b });
        pos = line.to + 1;
      }
      return false;
    },
  });
  return spans;
}

// --- Checking an edit against a fresh parse (RICH-18) -----------------------

/** A construct over a visible character: its node's name, a link's or an image's with its destination. */
interface Over { name: string; from: number; to: number }
/** A visible character of a text block, as a fresh parse reads it. */
interface Glyph { pos: number; ch: string; over: Over[] }

/**
 * What a character formatting command sets out to do: give the construct
 * `name` to the text of `must` (`on`), or take it away, and change it nowhere
 * else but in `free` — the run it writes, widened over what it partly
 * covered, or the runs it cuts. With `trims`, punctuation at either end of
 * `must` may stay outside the run, where no marker could open or close by it
 * (`flank`); constructs wholly inside `free` that `drops` names may go — any,
 * as a code span holds none, or a bare address a new link's text takes in.
 * `marker` holds the characters of the markers written. `replaced` is text
 * the command writes afresh, a link's: every visible character written in
 * its place must carry `name`, and nothing else there is compared.
 */
interface Intent {
  name: string; on: boolean; must: readonly Span[]; free: readonly Span[];
  trims?: boolean; drops?: (name: string) => boolean; marker?: string; replaced?: Span;
}

/** Syntax that shows nothing: marks, a checklist item's box, a link's label and title, a hard break. */
const HIDDEN = /Mark$|^(TaskMarker|LinkTitle|LinkLabel|HardBreak)$/;
/** Constructs text takes on with nothing written for them: a bare web address, an emoji's code. */
const BARE = new Set(["URL", "Emoji"]);
/** A no-break space: whitespace to the flanking rules, and no indentation to the block parser. */
const NBSP = String.fromCharCode(0xa0);
/** Plain text a new marker can turn into syntax, which a backslash keeps plain: delimiters and brackets. */
const STRAY = /^[*_~`[\]]$/;

/** The text block holding `pos`: a paragraph, heading, checklist item or table cell. */
function leafAt(tree: Tree, pos: number): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) if (INLINE_CONTAINER.test(n.name)) return n;
  }
  return null;
}

/**
 * Whether `pos` is where rich mode edits text: in a paragraph, heading,
 * checklist item or table cell, or on a line of prose holding no text yet.
 * Code, frontmatter and what rich mode shows as source (RICH-15) are not.
 */
function prose(state: EditorState, tree: Tree, pos: number): boolean {
  const leaf = leafAt(tree, pos);
  if (leaf) return !isFootnote(state, leaf);
  const info = lineInfo(state, tree, state.doc.lineAt(pos));
  return !info.skip && !info.block && info.content === info.line.to;
}

/** The document `set` makes, and its tree: parsed afresh where the changes reach, and reused from `tree` elsewhere. */
function reparse(state: EditorState, tree: Tree, set: ChangeSet): { doc: Text; tree: Tree } | null {
  const parser = state.facet(language)?.parser;
  if (!parser) return null;
  const doc = set.apply(state.doc);
  const ranges: ChangedRange[] = [];
  set.iterChangedRanges((fromA, toA, fromB, toB) => { ranges.push({ fromA, toA, fromB, toB }); });
  return { doc, tree: parser.parse(doc.toString(), TreeFragment.applyChanges(TreeFragment.addTree(tree), ranges)) };
}

/** What a text reads as: its visible characters, which of its positions are hidden syntax, and the blocks it parses into, line by line. */
interface Reading { glyphs: Glyph[]; hidden: Uint8Array; shape: string }

/** A text to scan: where it starts in what the tree was parsed from, the text, where it stands in the document, and whether it is a table cell's. */
interface Scanned { start: number; text: string; base: number; cell: boolean }

/**
 * The visible characters of `text`, the part of what `tree` was parsed from
 * that starts at `start`, with the constructs over each, as though it stood
 * at `base` in the document; `slice` reads the parsed text. Whitespace is no
 * glyph, and neither is syntax that shows nothing: marks, a link's
 * destination, an escape's backslash, and in a table cell the backslash
 * before a pipe in a code span, which GFM drops there. The escape itself is
 * no construct.
 */
function scan(tree: Tree, start: number, text: string, base: number, slice: (from: number, to: number) => string, cell: boolean): Reading {
  return scanAll(tree, [{ start, text, base, cell }], slice)[0];
}

/**
 * `scan` for texts that follow one another in what `tree` was parsed from,
 * in one walk of the tree rather than one from its top for each: a node
 * belongs to the text it starts in, or the next one after it.
 */
function scanAll(tree: Tree, items: readonly Scanned[], slice: (from: number, to: number) => string): Reading[] {
  if (!items.length) return [];
  const hidden = items.map((it) => new Uint8Array(it.text.length));
  // The constructs in document order, outer before inner.
  const constructs: Over[][] = items.map(() => []);
  const shapes: string[][] = items.map(() => []);
  const breaks: (number[] | undefined)[] = [];
  // The number of the line of text `k` holding offset `p`, counting from 1.
  const line = (k: number, p: number) => {
    const text = items[k].text;
    let list = breaks[k];
    if (!list) {
      list = breaks[k] = [];
      for (let q = text.indexOf("\n"); q >= 0; q = text.indexOf("\n", q + 1)) list.push(q);
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const last = items[items.length - 1];
  let k = 0;
  tree.iterate({
    from: items[0].start,
    to: last.start + last.text.length,
    enter: (n) => {
      if (n.type.isTop) return undefined;
      while (k < items.length - 1 && n.from > items[k].start + items[k].text.length) k++;
      const { start, text, base, cell } = items[k];
      const a = Math.max(0, n.from - start);
      const b = Math.min(text.length, n.to - start);
      const kind = kindOf(n.type);
      if (kind === BLOCK) {
        shapes[k].push(`${n.name}:${line(k, a)}-${line(k, b)}`);
        return undefined;
      }
      if (kind === SHOWS_NOTHING || (n.name === "URL" && isDestination(n.node, slice))) {
        hidden[k].fill(1, a, b);
        return false;
      }
      if (n.name === "Escape") {
        hidden[k][a] = 1;
        return false;
      }
      if (n.name === "InlineCode" && (cell || !!ancestorOf(n.node, "TableCell"))) {
        for (let p = a; p + 1 < b; p++) if (text[p] === "\\" && text[p + 1] === "|") hidden[k][p] = 1;
      }
      const url = n.name === "Link" || n.name === "Image" ? n.node.getChildren("URL").find((u) => isDestination(u, slice)) : null;
      constructs[k].push({ name: url ? `${n.name}(${slice(url.from, url.to)})` : n.name, from: base + a, to: base + b });
      return undefined;
    },
  });
  return items.map(({ text, base }, i) => {
    // One sweep; characters under the same constructs share one list.
    const glyphs: Glyph[] = [];
    const list = constructs[i];
    let over: Over[] = [];
    // Where the first of `over` ends, so a character inside them all costs one comparison.
    let ends = Infinity;
    for (let p = 0, next = 0; p < text.length; p++) {
      const pos = base + p;
      if (pos >= ends) {
        over = over.filter((o) => o.to > pos);
        ends = Math.min(...over.map((o) => o.to));
      }
      for (; next < list.length && list[next].from <= pos; next++) {
        if (list[next].to <= pos) continue;
        over = [...over, list[next]];
        ends = Math.min(ends, list[next].to);
      }
      if (!hidden[i][p] && !blank(text.charCodeAt(p))) glyphs.push({ pos, ch: text[p], over });
    }
    return { glyphs, hidden: hidden[i], shape: shapes[i].join(" ") };
  });
}

/** Whether the character with code `c` is whitespace, as `\s` has it; printable ASCII is not, without asking. */
const blank = (c: number) => (c > 32 && c < 127 ? false : /\s/.test(String.fromCharCode(c)));

const BLOCK = 1;
const SHOWS_NOTHING = 2;
const kinds = new WeakMap<NodeType, number>();

/** A node type as `scan` treats it, worked out once per type: a block, syntax that shows nothing, or 0 for anything else. */
function kindOf(type: NodeType): number {
  let kind = kinds.get(type);
  if (kind === undefined) kinds.set(type, kind = type.is("Block") ? BLOCK : HIDDEN.test(type.name) ? SHOWS_NOTHING : 0);
  return kind;
}

function ancestorOf(n: SyntaxNode, name: string): SyntaxNode | null {
  for (let p = n.parent; p; p = p.parent) if (p.name === name) return p;
  return null;
}

/**
 * `from`–`to`, the text of one text block, as `parser` reads it standing
 * alone (`scan`). A quote's marks on its lines are blanked first, as the
 * parser blanks them inside a quote. A paragraph or a setext heading's text
 * is a paragraph standing alone too; the text of any other block takes
 * `lead`, a no-break space, which reads as the start of a line does and
 * keeps a `#`, `-` or `>` there from opening a block. `cell` says the text
 * is a table cell's.
 */
function read(parser: Parser, doc: Source, from: number, to: number, blanks: readonly Span[], lead: string, cell: boolean): Reading {
  const text = blanked(doc, from, to, blanks);
  const input = lead + text;
  return scan(parser.parse(input), lead.length, text, from, (a, b) => input.slice(a, b), cell);
}

/** Text to read from: a document, or a document's text as a string. */
interface Source { sliceString(from: number, to: number): string }

/** `from`–`to` with the quote marks `blanks` on its lines turned to spaces. */
function blanked(doc: Source, from: number, to: number, blanks: readonly Span[]): string {
  const text = doc.sliceString(from, to);
  if (!blanks.length) return text;
  const chars = text.split("");
  for (const b of blanks) for (let p = Math.max(b.from, from); p < Math.min(b.to, to); p++) chars[p - from] = " ";
  return chars.join("");
}

/** A text block to read: its text, the quote marks on its lines, its lead, whether it is a table cell's. */
interface Piece extends Span { blanks: readonly Span[]; lead: string; cell: boolean }

/** A shape of text blocks alone, which a blank line after closes: nothing in it runs on into what follows. */
const CLOSED = /^(?:(?:Paragraph|ATXHeading[1-6]|SetextHeading[12]):\d+-\d+(?: |$))*$/;

/**
 * `read` for many text blocks at once: their texts parsed as one, each a
 * blank line after the one before, since one parse costs far less than
 * thousands. A text that parses into anything but text blocks — a list, a
 * fence — could run on into the next, so from the first such one on, each
 * is read alone; the readings are `read`'s either way.
 */
function readMany(parser: Parser, doc: Source, pieces: readonly Piece[]): Reading[] {
  const texts = pieces.map((p) => blanked(doc, p.from, p.to, p.blanks));
  const starts: number[] = [];
  const parts: string[] = [];
  let length = 0;
  pieces.forEach((p, i) => {
    starts.push(length + p.lead.length);
    parts.push(p.lead, texts[i], "\n\n");
    length += p.lead.length + texts[i].length + 2;
  });
  const input = parts.join("");
  const slice = (a: number, b: number) => input.slice(a, b);
  const readings = scanAll(parser.parse(input), pieces.map((p, i) => ({ start: starts[i], text: texts[i], base: p.from, cell: p.cell })), slice);
  const out: Reading[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const r = readings[i];
    if (!CLOSED.test(r.shape)) {
      for (const p of pieces.slice(i)) out.push(read(parser, doc, p.from, p.to, p.blanks, p.lead, p.cell));
      break;
    }
    out.push(r);
  }
  return out;
}

/** The cells a table row's line holds, counted as the GFM parser splits them: at each pipe no backslash escapes. */
function cellCount(line: string): number {
  let count = 0;
  let first = true;
  let open = false;
  let escaped = false;
  for (const ch of line) {
    if (ch === "|" && !escaped) {
      if (!first || open) count++;
      first = false;
      open = false;
    } else if (escaped || (ch !== " " && ch !== "\t")) open = true;
    escaped = !escaped && ch === "\\";
  }
  return open ? count + 1 : count;
}

/**
 * `set.mapPos` for many positions: that walks every change on each call,
 * which a check of thousands of blocks cannot afford, so this finds the one
 * change that matters by binary search. The results are `mapPos`'s.
 */
function mapper(set: ChangeSet): (pos: number, assoc: -1 | 1) => number {
  const fromA: number[] = [];
  const toA: number[] = [];
  const fromB: number[] = [];
  const toB: number[] = [];
  set.iterChanges((a, b, c, d) => { fromA.push(a); toA.push(b); fromB.push(c); toB.push(d); });
  const shift = set.newLength - set.length;
  return (pos, assoc) => {
    let lo = 0;
    let hi = toA.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (toA[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    if (lo === toA.length) return pos + shift;
    if (fromA[lo] > pos) return pos + fromB[lo] - fromA[lo];
    if (fromA[lo] === toA[lo]) return assoc < 0 ? fromB[lo] : toB[lo];
    if (pos === fromA[lo]) return fromB[lo];
    if (pos === toA[lo]) return toB[lo];
    return assoc < 0 ? fromB[lo] : toB[lo];
  };
}

/**
 * Whether the glyphs `after` are `before` changed only as `intent` allows.
 * `written` is where `intent.replaced` stands after the changes.
 */
function kept(before: readonly Glyph[], after: readonly Glyph[], intent: Intent, written?: Span): boolean {
  if (intent.replaced && written) {
    const outside = (s: Span) => (g: Glyph) => g.pos < s.from || g.pos >= s.to;
    const fresh = after.filter((g) => !outside(written)(g));
    if (!fresh.length || fresh.some((g) => !g.over.some((o) => o.name === intent.name))) return false;
    before = before.filter(outside(intent.replaced));
    after = after.filter(outside(written));
  }
  if (before.length !== after.length) return false;
  const inside = (spans: readonly Span[], pos: number) => spans.some((s) => s.from <= pos && pos < s.to);
  const must = intent.must.map((s) => {
    if (!intent.trims) return s;
    const core = before.filter((g) => s.from <= g.pos && g.pos < s.to && !isPunct(g.ch));
    return core.length ? { from: core[0].pos, to: core[core.length - 1].pos + 1 } : { from: s.from, to: s.from };
  });
  const sets = new Map<readonly Over[], Set<string>>();
  const names = (g: Glyph) => {
    let set = sets.get(g.over);
    if (!set) sets.set(g.over, set = new Set(g.over.filter((o) => o.name !== intent.name).map((o) => o.name)));
    return set;
  };
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const a = after[i];
    if (b.ch !== a.ch) return false;
    const required = inside(must, b.pos);
    const free = required || inside(intent.free, b.pos);
    const had = b.over.some((o) => o.name === intent.name);
    const has = a.over.some((o) => o.name === intent.name);
    if (required && has !== intent.on) return false;
    if (free ? (intent.on ? had && !has : has && !had) : has !== had) return false;
    // Every other construct stays, but one `drops` lets go; a bare address may become a link.
    const now = names(a);
    const was = names(b);
    for (const o of b.over) {
      if (o.name === intent.name || now.has(o.name)) continue;
      if (!(free && intent.drops?.(o.name) && intent.free.some((s) => s.from <= o.from && o.to <= s.to))) return false;
    }
    for (const n of now) if (!was.has(n) && !(free && BARE.has(n))) return false;
  }
  return true;
}

/**
 * `changes`, when a fresh parse of every text block they touch shows them
 * doing what `intent` says and nothing else (RICH-18): the visible text the
 * same character for character, every construct outside `intent.free` as it
 * was, and the text of `intent.must` with the construct throughout, or
 * without it. When they fail, the one fallback escapes the plain `*`, `_`,
 * `~` or bracket a new marker would pair with, and checks again. Null when
 * they still fail: the command does nothing, as no edit beats a wrong one.
 * A table row must also keep its number of cells, which a pipe the changes
 * unescape would change. The changes come back as one set, built once from
 * changes sorted by position. The blocks' texts are parsed together, once
 * before and once for each check (`readMany`), and what a block costs
 * besides does not grow with the rest of the selection.
 */
function checked(state: EditorState, tree: Tree, changes: readonly Change[], intent: Intent): ChangeSet | null {
  const byPos = (a: { from: number }, b: { from: number }) => a.from - b.from;
  const base = state.changes([...changes].sort(byPos));
  if (base.empty) return base;
  const parser = state.facet(language)?.parser;
  if (!parser) return null;
  const doc = state.doc;
  interface Block extends Piece { own: Intent & { must: Span[]; free: Span[] } }
  const byStart = new Map<number, Block>();
  // The cells of each table row touched, by a position in the row: its first cell's text.
  const rows = new Map<number, { probe: number; cells: number }>();
  const at: number[] = [];
  base.iterChanges((fromA, toA) => { at.push(fromA, toA); });
  for (const s of intent.must) at.push(s.from, s.to);
  // In order, a position inside the text block found last needs no search.
  at.sort((a, b) => a - b);
  let last: Span | null = null;
  for (const pos of at) {
    if (last && last.from <= pos && pos <= last.to) continue;
    const leaf = leafAt(tree, pos);
    if (!leaf) return null;
    const text = textOf(state, leaf);
    if (pos < text.from || pos > text.to) return null;
    last = text;
    if (byStart.has(text.from)) continue;
    const blanks = nodesNamed(tree, "QuoteMark", text.from, text.to).map((q) => ({ from: q.from, to: q.to }));
    const lead = /^(Paragraph|SetextHeading)/.test(leaf.name) ? "" : NBSP;
    const cell = leaf.name === "TableCell";
    if (cell) {
      const line = doc.lineAt(text.from);
      if (!rows.has(line.from)) rows.set(line.from, { probe: text.from, cells: cellCount(line.text) });
    }
    byStart.set(text.from, { ...text, blanks, lead, cell, own: { ...intent, must: [], free: [] } });
  }
  // Each block takes the part of the intent beside it, found by binary
  // search: the blocks are disjoint, so sorted by start they are sorted by end.
  const blocks = [...byStart.values()].sort((a, b) => a.from - b.from);
  const befores = readMany(parser, doc, blocks);
  const share = (spans: readonly Span[], key: "must" | "free") => {
    for (const s of spans) {
      let lo = 0;
      let hi = blocks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (blocks[mid].to + 1 < s.from) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < blocks.length && blocks[i].from - 1 <= s.to; i++) blocks[i].own[key].push(s);
    }
  };
  share(intent.must, "must");
  share(intent.free, "free");
  const whole = doc.toString();
  const test = (extra: readonly Change[]) => {
    const set = extra.length ? state.changes([base, [...extra].sort(byPos)]) : base;
    // The document after the changes as one string, joined in one pass: `set.apply` replaces its way through thousands.
    const parts: string[] = [];
    let pos = 0;
    set.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      parts.push(whole.slice(pos, fromA), inserted.toString());
      pos = toA;
    });
    parts.push(whole.slice(pos));
    const text = parts.join("");
    const next = { sliceString: (from: number, to: number) => text.slice(from, to) };
    const lineAt = (at: number) => {
      const end = text.indexOf("\n", at);
      return text.slice(at > 0 ? text.lastIndexOf("\n", at - 1) + 1 : 0, end < 0 ? text.length : end);
    };
    const map = mapper(set);
    const strays = new Set<number>();
    let ok = true;
    for (const { probe, cells } of rows.values()) if (cellCount(lineAt(map(probe, -1))) !== cells) ok = false;
    const moved = blocks.map((b) => ({
      ...b,
      from: map(b.from, -1),
      to: map(b.to, 1),
      blanks: b.blanks.map((q) => {
        const p = map(q.from, 1);
        return { from: p, to: p + q.to - q.from };
      }),
    }));
    const afters = readMany(parser, next, moved);
    blocks.forEach((b, i) => {
      const { from, to } = moved[i];
      const before = befores[i];
      const after = afters[i];
      const r = intent.replaced;
      const written = r && r.from >= b.from && r.to <= b.to ? { from: map(r.from, -1), to: map(r.to, 1) } : undefined;
      // No block may start or end: a `~~~` or three backticks at a line's start would be a code fence.
      if (after.shape === before.shape && kept(before.glyphs, after.glyphs, b.own, written)) return;
      ok = false;
      for (const g of before.glyphs) {
        const q = map(g.pos, 1);
        if (q >= from && q < to && after.hidden[q - from]) strays.add(g.pos);
      }
    });
    return { ok, set, strays };
  };
  const extra: Change[] = [];
  let result = test(extra);
  // The one fallback: escape the plain delimiters and brackets the changes
  // turned into syntax, and every plain one of the markers' own characters in
  // or beside the runs, which a new marker could pair with in its place. An
  // escape can let the next plain delimiter pair instead, so it goes on while
  // it finds more, three times at most.
  const escaped = new Set<number>();
  for (let round = 0; !result.ok && round < 3; round++) {
    const count = extra.length;
    for (const [i, { own }] of blocks.entries()) {
      for (const g of befores[i].glyphs) {
        if (escaped.has(g.pos) || g.over.some((o) => ATOMIC.has(o.name))) continue;
        const stray = result.strays.has(g.pos) && STRAY.test(g.ch);
        const near = round === 0 && own.marker?.includes(g.ch) && own.free.some((s) => s.from - 1 <= g.pos && g.pos <= s.to);
        if (!stray && !near) continue;
        escaped.add(g.pos);
        extra.push({ from: g.pos, insert: "\\" });
      }
    }
    if (extra.length === count) return null;
    result = test(extra);
  }
  return result.ok ? result.set : null;
}

/** An intent that changes nothing: every construct over every glyph stays. */
const SAME: Intent = { name: "", on: false, must: [], free: [] };

/**
 * `changes`, a block command's, when they leave the text as it reads: every
 * visible character of the text blocks they touch, and of the lines on
 * either side, the same after them and under the same inline constructs
 * (RICH-18). A block's syntax changes, its text and formatting do not; a
 * next item taken in as text, or `**` left without its pair, fails. The
 * document after them is parsed afresh where they reach. Null when they
 * fail: the command does nothing, as no edit beats a wrong one.
 */
function blockChecked(state: EditorState, tree: Tree, changes: readonly ChangeSpec[]): ChangeSet | null {
  const set = state.changes(changes);
  if (set.empty) return set;
  const doc = state.doc;
  let from = doc.length;
  let to = 0;
  let last = 0;
  const take = (n: number) => {
    if (n < 1 || n > doc.lines || n <= last) return;
    last = n;
    const line = doc.line(n);
    const block = lineInfo(state, tree, line).block;
    from = Math.min(from, block ? doc.lineAt(block.from).from : line.from);
    to = Math.max(to, block ? doc.lineAt(block.to).to : line.to);
  };
  set.iterChangedRanges((fromA, toA) => {
    const first = doc.lineAt(fromA).number;
    for (let n = first - 1; n <= doc.lineAt(toA).number + 1; n++) take(n);
  });
  const fresh = reparse(state, tree, set);
  if (!fresh) return null;
  const a = set.mapPos(from, -1);
  const b = set.mapPos(to, 1);
  const before = scan(tree, from, doc.sliceString(from, to), from, (x, y) => doc.sliceString(x, y), false);
  const after = scan(fresh.tree, a, fresh.doc.sliceString(a, b), a, (x, y) => fresh.doc.sliceString(x, y), false);
  return kept(before.glyphs, after.glyphs, SAME) ? set : null;
}

// --- Character formatting (RICH-04) ----------------------------------------

/** No widget blocks or hidden lines: a word never leaves its line, and only the line's own syntax is in its way. */
const ONE_LINE: Layout = { blocks: [], tables: [], merges: [], gaps: [], exempt: [] };

/**
 * The visible word the caret is inside, from its first letter to its last,
 * read past the syntax rich mode hides (RICH-02), so `wo**rd**` is one word;
 * null when the caret sits between words.
 */
export function wordAt(state: EditorState, pos: number): Span | null {
  const cat = state.charCategorizer(pos);
  const letter = (u: Unit | null): u is Unit => !!u && u.char !== "\n" && cat(u.char) === CharCategory.Word;
  const back = step(state, ONE_LINE, pos, false);
  const ahead = step(state, ONE_LINE, pos, true);
  if (!letter(back) || !letter(ahead)) return null;
  let from = back.from;
  for (let u = step(state, ONE_LINE, from, false); letter(u); u = step(state, ONE_LINE, from, false)) from = u.from;
  let to = ahead.to;
  for (let u = step(state, ONE_LINE, to, true); letter(u); u = step(state, ONE_LINE, to, true)) to = u.to;
  return { from, to };
}

/**
 * The inline syntax in `from`–`to` that rich mode hides, in document order,
 * and the nodes named `name` over or touching it, found in the same walk.
 */
function hiddenIn(doc: Text, tree: Tree, from: number, to: number, name: string): { hidden: Span[]; named: SyntaxNode[] } {
  const hidden: Span[] = [];
  const named: SyntaxNode[] = [];
  iterateAround(tree, from, to, (n) => {
    if (n.name === name && n.from <= to && n.to >= from) named.push(n.node);
    if (SYNTAX.has(n.name) || n.name === "QuoteMark" || n.name === "LinkTitle" || n.name === "LinkLabel" || (n.name === "URL" && isDestination(n.node, (a, b) => doc.sliceString(a, b)))) hidden.push({ from: n.from, to: n.to });
    else if (n.name === "Escape") hidden.push({ from: n.from, to: n.from + 1 });
  });
  return { hidden, named };
}

/** Whether every visible character of `spans` already carries `mark`: the syntax rich mode hides does not count. */
function covered(state: EditorState, tree: Tree, mark: Mark, spans: Span[]): boolean {
  let any = false;
  for (const s of spans) {
    // Nodes come in document order; the sweeps only move forward.
    const { hidden, named: nodes } = hiddenIn(state.doc, tree, s.from, s.to, NODE[mark]);
    const text = state.doc.sliceString(s.from, s.to);
    let k = 0;
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      if (isSpace(text[i])) continue;
      const p = s.from + i;
      while (h < hidden.length && hidden[h].to <= p) h++;
      if (h < hidden.length && hidden[h].from <= p) continue;
      any = true;
      while (k < nodes.length && nodes[k].to <= p) k++;
      let inside = false;
      for (let j = k; j < nodes.length && nodes[j].from <= p && !inside; j++) inside = p < nodes[j].to;
      if (!inside) return false;
    }
  }
  return any;
}

/**
 * Whether a caret at `pos` carries `mark`: whether the text before it does,
 * as typing continues the formatting it follows (RICH-03). A caret after a
 * run's closing marker carries it; one before its opening marker does not,
 * except at the start of a line, where typing joins the text after it.
 */
function activeAt(state: EditorState, tree: Tree, mark: Mark, pos: number): boolean {
  return nodesNamed(tree, NODE[mark], pos, pos).some((n) => {
    const d = delimiters(n);
    if (!d || pos < d.open.to || pos > n.to) return false;
    return pos > d.open.to || lineInfo(state, tree, state.doc.lineAt(n.from)).content === n.from;
  });
}

/**
 * `from`–`to` widened until writing syntax at its ends cannot cut another
 * construct: a range that starts or ends inside a link's destination, a code
 * span or a citation takes in the whole of it, as it does emphasis it only
 * partly covers. With `merge`, a node of that name it touches is taken in
 * too, so bold written beside bold becomes one run.
 */
function balance(state: EditorState, tree: Tree, from: number, to: number, merge: string | null): Span {
  const doc = state.doc;
  let a = from;
  let b = to;
  for (let changed = true; changed;) {
    changed = false;
    iterateAround(tree, a, b, (n) => {
      if (changed || n.to < a || n.from > b) return false;
      // The same formatting overlapping or touching the range joins it.
      if (n.name === merge) {
        if (n.from < a || n.to > b) {
          a = Math.min(a, n.from);
          b = Math.max(b, n.to);
          changed = true;
        }
        return false;
      }
      if ((n.from >= a && n.to <= b) || n.to === a || n.from === b) return false;
      const room = nestable(n.node, doc);
      if (room && room.from <= a && b <= room.to) return;
      a = Math.min(a, n.from);
      b = Math.max(b, n.to);
      changed = true;
      return false;
    });
  }
  return { from: a, to: b };
}

/**
 * Where a new run of `mark` over `span` goes: `span` balanced, then widened
 * until the markers written at its ends open and close there, and leave the
 * marks of a construct beside them opening and closing as they did. A marker
 * cannot open against a letter before it when punctuation follows it — the
 * syntax of a construct taken in, or a mark it stands against — nor close in
 * the mirror case, so an end that fails moves out over the rest of its word,
 * to the whitespace or the edge of the line's text: Markdown formats the
 * whole word where it cannot format the part. A code span's backticks follow
 * no such rule, but a `**` glued to a word stops closing beside one, so a
 * code span takes in whole the construct whose mark it would stand against,
 * and drops its formatting as it drops all it holds.
 */
function reach(state: EditorState, tree: Tree, mark: Mark, span: Span): Span {
  const doc = state.doc;
  const name = NODE[mark];
  const marker = MARKER[mark];
  const ch = marker[0];
  const leaf = leafAt(tree, span.from);
  const text = leaf ? textOf(state, leaf) : span;
  const line = doc.lineAt(span.from);
  const lim = { from: Math.max(text.from, line.from + LEAD.exec(line.text)![0].length), to: Math.min(text.to, line.to) };
  // Past the line's text is the start or end of a line: whitespace to the flanking rules.
  const at = (p: number) => (p < lim.from || p >= lim.to ? "" : line.text[p - line.from]);
  // A marker of the run's own at an end stays, and nothing is written there.
  const own = (p: number, open: boolean) => nodesNamed(tree, name, p, p).some((n) => {
    const m = delimiters(n)?.[open ? "open" : "close"];
    return !!m && (open ? m.from : m.to) === p && doc.sliceString(m.from, m.to) === marker;
  });
  // Where a marker at `p` stands: `p` itself when it fits, else the end the run moves out to.
  const fit = (p: number, open: boolean): number => {
    const dir = open ? -1 : 1;
    const edge = () => {
      let q = p;
      while (at(open ? q - 1 : q) !== "" && !isSpace(at(open ? q - 1 : q))) q += dir;
      return q;
    };
    if (ch !== "`" && own(p, open)) return p;
    // The marker joins a run of its character already there.
    let a = p;
    let b = p;
    if (ch !== "`") {
      while (at(a - 1) === ch) a--;
      while (at(b) === ch) b++;
      if (!canFlank(ch, at(a - 1), at(b), open)) return edge();
    }
    // A construct's mark of another character beside the run must open and
    // close exactly as before: one that could now also close might pair
    // with an opener further back.
    for (const q of [a - 1, b]) {
      const c = at(q);
      const m = /^[*_~]$/.test(c) && c !== ch ? tree.resolveInner(q, 1) : null;
      if (!m?.parent || !/^(EmphasisMark|StrikethroughMark)$/.test(m.name)) continue;
      let x = q;
      let y = q + 1;
      while (at(x - 1) === c) x--;
      while (at(y) === c) y++;
      const was = [true, false].map((o) => canFlank(c, at(x - 1), at(y), o));
      const now = [true, false].map((o) => canFlank(c, q < a ? at(x - 1) : ch, q < a ? ch : at(y), o));
      if (was[0] !== now[0] || was[1] !== now[1]) return ch === "`" ? (open ? Math.min(p, m.parent.from) : Math.max(p, m.parent.to)) : edge();
    }
    return p;
  };
  let r = balance(state, tree, span.from, span.to, name);
  for (let i = 0; i < 4; i++) {
    const from = fit(r.from, true);
    const to = fit(r.to, false);
    if (from === r.from && to === r.to) break;
    r = balance(state, tree, from, to, name);
  }
  return r;
}

/** What a new code span looks for over its run: the code, formatting and links it takes the syntax of, and the escapes it drops. */
const CODE_TAKES = new Set(["InlineCode", "Emphasis", "StrongEmphasis", "Strikethrough", "Link", "Autolink", "Escape", "HardBreak"]);

/** A command's changes for one span of text: `region` is where it writes, `free` where it may change the formatting (`Intent`). */
interface Written { changes: Change[]; region: Span; free: Span[] }

/** The changes that give the text of `span` the formatting `mark`. */
function addMark(state: EditorState, tree: Tree, mark: Mark, span: Span): Written {
  const doc = state.doc;
  const name = NODE[mark];
  const t = mark === "code" ? trim(doc, span.from, span.to) : flank(doc, span);
  const none: Written = { changes: [], region: t, free: [] };
  if (t.from >= t.to) return none;
  // Already inside that formatting: nothing to add.
  const within = nodesNamed(tree, name, t.from, t.to).some((n) => {
    const d = delimiters(n);
    return !!d && d.open.to <= t.from && t.to <= d.close.from;
  });
  if (within) return none;
  const { from, to } = reach(state, tree, mark, t);
  const changes: Change[] = [];
  const removed: Span[] = [];
  let open = MARKER[mark];
  let close = open;
  // The same formatting inside the range joins the new run. A marker of its
  // already standing where the run starts or ends is kept as the run's own.
  let keepOpen = false;
  let keepClose = false;
  const strip = (span: Span, keep: boolean) => {
    if (keep) return;
    changes.push({ from: span.from, to: span.to });
    removed.push(span);
  };
  // The nodes this needs over the run, in one walk; a code span needs more.
  const wanted = mark === "code" ? CODE_TAKES : new Set([name]);
  const found = new Map<string, SyntaxNode[]>();
  iterateAround(tree, from, to, (n) => {
    if (!wanted.has(n.name) || n.from > to || n.to < from) return;
    const list = found.get(n.name);
    if (list) list.push(n.node);
    else found.set(n.name, [n.node]);
  });
  const named = (kind: string) => found.get(kind) ?? [];
  for (const n of named(name)) {
    const d = delimiters(n);
    if (!d || n.from < from || n.to > to) continue;
    const reuse = mark !== "code";
    const o: boolean = reuse && !keepOpen && d.open.from === from && doc.sliceString(d.open.from, d.open.to) === open;
    const c: boolean = reuse && !keepClose && d.close.to === to && doc.sliceString(d.close.from, d.close.to) === close;
    keepOpen ||= o;
    keepClose ||= c;
    strip(d.open, o);
    strip(d.close, c);
  }
  if (mark === "code") {
    // A code span holds no formatting and no link, so what the range had goes
    // and a link leaves its text, and its fence is longer than any run of
    // backticks left inside it.
    for (const other of ["Emphasis", "StrongEmphasis", "Strikethrough", "Link", "Autolink"]) {
      for (const n of named(other)) {
        if (n.from < from || n.to > to) continue;
        const text = textSpan(n, doc);
        if (text.from === n.from) continue;
        strip({ from: n.from, to: text.from }, false);
        strip({ from: text.to, to: n.to }, false);
      }
    }
    // Nor does it hold an escape: the backslash of one, or of a hard break,
    // would show there. In a table cell a pipe's stays, or the pipe would
    // end the cell: GFM drops that one backslash inside a code span.
    const cell = leafAt(tree, from)?.name === "TableCell";
    for (const n of [...named("Escape"), ...named("HardBreak")]) {
      const slash = { from: n.from, to: n.from + 1 };
      if (cell && n.name === "Escape" && doc.sliceString(slash.to, n.to) === "|") continue;
      if (n.from >= from && n.to <= to && doc.sliceString(n.from, slash.to) === "\\" && !removed.some((r) => r.from <= slash.from && slash.to <= r.to)) strip(slash, false);
    }
    let text = "";
    let pos = from;
    for (const r of [...removed].sort((x, y) => x.from - y.from)) {
      text += doc.sliceString(pos, r.from);
      pos = Math.max(pos, r.to);
    }
    text += doc.sliceString(pos, to);
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    open = fence + pad;
    close = pad + fence;
  }
  if (!keepOpen) changes.push({ from, insert: open });
  if (!keepClose) changes.push({ from: to, insert: close });
  return { changes, region: { from, to }, free: [{ from, to }] };
}

/** Where the text of an inline construct starts and ends, inside its syntax. */
function textSpan(n: SyntaxNode, doc: Text): Span {
  if (n.name === "Autolink") return { from: n.from + 1, to: n.to - 1 };
  const d = n.name === "Link" ? linkParts(n, doc) : null;
  if (d) return { from: d.open.to, to: d.close.from };
  const m = delimiters(n);
  return m ? { from: m.open.to, to: m.close.from } : n;
}

/**
 * The changes that take the formatting `mark` off the text of `span`, keeping
 * it on the rest of each run. A cut never goes through a construct nested in
 * the run: one the span reaches into loses the formatting whole, as one it
 * partly covers gains it whole (`balance`). The same formatting nested in
 * the run adds nothing to it, so its markers go and the cut runs through its
 * text.
 */
function removeMark(state: EditorState, tree: Tree, mark: Mark, span: Span): Written {
  const doc = state.doc;
  const name = NODE[mark];
  const t = trim(doc, span.from, span.to);
  const changes: Change[] = [];
  const runs: Span[] = [];
  if (t.from >= t.to) return { changes, region: span, free: runs };
  const flattened = new Set<number>();
  for (const n of nodesNamed(tree, name, t.from, t.to)) {
    const d = delimiters(n);
    if (!d || flattened.has(n.from)) continue;
    let s = Math.max(t.from, d.open.to);
    let e = Math.min(t.to, d.close.from);
    if (s >= e) continue;
    runs.push({ from: n.from, to: n.to });
    const parts: (Part & { text: Span })[] = [];
    const nested: SyntaxNode[] = [];
    const walk = (p: SyntaxNode, from: number, to: number) => {
      for (let c = p.firstChild; c; c = c.nextSibling) {
        if (c.from < from || c.to > to) continue;
        const same = c.name === name ? delimiters(c) : null;
        if (same) {
          nested.push(c);
          for (const m of [same.open, same.close]) parts.push({ ...m, blank: true, text: m });
          walk(c, same.open.to, same.close.from);
        } else parts.push({ from: c.from, to: c.to, blank: c.name === "QuoteMark", text: textSpan(c, doc) });
      }
    };
    walk(n, d.open.to, d.close.from);
    for (const u of parts) {
      if (u.from < s && s < u.to) s = s >= u.text.to ? u.to : u.from;
      if (u.from < e && e < u.to) e = e <= u.text.from ? u.from : u.to;
    }
    if (s >= e) continue;
    for (const c of nested) {
      const m = delimiters(c)!;
      flattened.add(c.from);
      changes.push({ from: m.open.from, to: m.open.to }, { from: m.close.from, to: m.close.to });
    }
    const openText = doc.sliceString(d.open.from, d.open.to);
    const closeText = doc.sliceString(d.close.from, d.close.to);
    // What stays formatted on either side, less the whitespace and
    // punctuation at the cut that a marker there could not open or close by.
    // A `_` run that cannot close or reopen at the cut is written with `*`.
    const marker = openText[0] === "_" ? "_*" : openText[0];
    const left = mark === "code" ? trim(doc, d.open.to, s) : flank(doc, { from: d.open.to, to: s }, parts, { end: 1, marker });
    const right = mark === "code" ? trim(doc, e, d.close.from) : flank(doc, { from: e, to: d.close.from }, parts, { end: -1, marker });
    const keepLeft = left.from < left.to;
    const keepRight = right.from < right.to;
    // `_` cannot open or close inside a word, nor against a letter on one side and punctuation on the other.
    const fails = (p: number, open: boolean) => !canFlank("_", near(doc, parts, p, -1), near(doc, parts, p, 1), open);
    const star = openText.startsWith("_") && ((keepLeft && fails(left.to, false)) || (keepRight && fails(right.from, true)));
    const o = star ? openText.replace(/_/g, "*") : openText;
    const c = star ? closeText.replace(/_/g, "*") : closeText;
    if (!keepLeft) changes.push({ from: d.open.from, to: d.open.to });
    else {
      if (star) changes.push({ from: d.open.from, to: d.open.to, insert: o });
      changes.push({ from: left.to, insert: c });
    }
    if (!keepRight) changes.push({ from: d.close.from, to: d.close.to });
    else {
      changes.push({ from: right.from, insert: o });
      if (star) changes.push({ from: d.close.from, to: d.close.to, insert: c });
    }
  }
  return { changes, region: span, free: runs };
}

/**
 * Formatting chosen with the caret between words, for what is typed next
 * (RICH-04): each entry says whether that formatting is on or off, against
 * what the caret's place already has.
 */
export interface Pending { pos: number; marks: Partial<Record<Mark, boolean>> }

export const setPending = StateEffect.define<Pending | null>();

/** Lives until the caret moves or the document changes by any other route. */
export const pendingField = StateField.define<Pending | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPending)) return e.value;
    return tr.docChanged || tr.selection ? null : value;
  },
});

function togglePending(state: EditorState, tree: Tree, mark: Mark): TransactionSpec | null {
  const pos = state.selection.main.head;
  if (!prose(state, tree, pos)) return null;
  const prev = state.field(pendingField, false);
  const marks = prev && prev.pos === pos ? { ...prev.marks } : {};
  const active = activeAt(state, tree, mark, pos);
  const now = marks[mark] ?? active;
  if (!now === active) delete marks[mark];
  else marks[mark] = !now;
  return { effects: setPending.of(Object.keys(marks).length ? { pos, marks } : null) };
}

/**
 * Toggles `mark` on the selection, or on the word holding the caret. Text
 * that has it everywhere loses it; text that has it in part, or not at all,
 * gets it everywhere, one run (RICH-04). A caret between words sets it for
 * what is typed next instead. Code, frontmatter and what rich mode shows as
 * source take none. Null, and no change, when the parser would read the
 * change otherwise than as that (`checked`).
 */
export function toggleMark(state: EditorState, mark: Mark): TransactionSpec | null {
  const tree = treeOf(state);
  const sel = state.selection;
  if (sel.ranges.length === 1 && sel.main.empty && !wordAt(state, sel.main.head)) return togglePending(state, tree, mark);
  const ranges = sel.ranges.map((r) => (r.empty ? wordAt(state, r.head) : r)).filter((r): r is Span => !!r);
  const spans = ranges.flatMap((r) => inlineSpans(state, tree, r.from, r.to));
  if (!spans.length) return null;
  const on = !covered(state, tree, mark, spans);
  const changes: Change[] = [];
  const must: Span[] = [];
  const free: Span[] = [];
  // Two cursors on one run would write overlapping changes; the first wins.
  // The regions taken are disjoint and kept sorted, so only the one before
  // where a new region would go can overlap it; spans come in document
  // order, so that is nearly always the last.
  const done: Span[] = [];
  for (const s of spans) {
    const w = on ? addMark(state, tree, mark, s) : removeMark(state, tree, mark, s);
    let i = done.length;
    while (i > 0 && done[i - 1].from >= w.region.to) i--;
    if (i > 0 && done[i - 1].to > w.region.from) continue;
    done.splice(i, 0, w.region);
    must.push(s);
    free.push(...w.free);
    changes.push(...w.changes);
  }
  const ok = checked(state, tree, changes, markIntent(mark, on, must, free));
  return ok && commit(state, ok);
}

/** What giving `mark` to the text of `must`, or taking it away, promises (`Intent`). */
function markIntent(mark: Mark, on: boolean, must: Span[], free: Span[]): Intent {
  // A run cut in two reopens with its own markers, `_` or `*` alike.
  const marker = mark === "code" ? "" : mark === "strike" ? "~" : on ? "*" : "*_";
  return { name: NODE[mark], on, must, free, trims: on && mark !== "code", drops: on && mark === "code" ? () => true : undefined, marker };
}

/**
 * Text typed at a caret carrying pending formatting, written with that
 * formatting in the same transaction, or null when nothing is pending there.
 * Whitespace alone is typed plainly and keeps the formatting pending, as
 * syntax cannot open on a space.
 */
export function typeWithPending(state: EditorState, text: string): TransactionSpec | null {
  const pending = state.field(pendingField, false);
  const sel = state.selection;
  if (!pending || sel.ranges.length !== 1 || !sel.main.empty || sel.main.head !== pending.pos) return null;
  const pos = pending.pos;
  if (!/\S/.test(text)) {
    return {
      changes: { from: pos, insert: text },
      selection: EditorSelection.cursor(pos + text.length),
      effects: setPending.of({ pos: pos + text.length, marks: pending.marks }),
      userEvent: "input.type",
    };
  }
  let changes = state.changes({ from: pos, insert: text });
  let current = state.update({ changes }).state;
  let from = pos;
  let to = pos + text.length;
  for (const mark of MARKS) {
    const want = pending.marks[mark];
    if (want === undefined) continue;
    const tree = treeOf(current);
    const w = want ? addMark(current, tree, mark, { from, to }) : removeMark(current, tree, mark, { from, to });
    // Formatting the parser would not read as promised is left off, and the text typed plainly.
    const set = checked(current, tree, w.changes, markIntent(mark, want, [{ from, to }], w.free));
    if (!set || set.empty) continue;
    changes = changes.compose(set);
    from = set.mapPos(from, 1);
    to = set.mapPos(to, -1);
    current = current.update({ changes: set }).state;
  }
  return { changes, selection: EditorSelection.cursor(to), userEvent: "input.type", scrollIntoView: true };
}

// --- Blocks (RICH-05, RICH-06, RICH-07) -------------------------------------

interface LineInfo {
  line: Line;
  /** The paragraph, heading or checklist item whose text is on this line. */
  block: SyntaxNode | null;
  /** Whether `block` starts on this line. */
  first: boolean;
  listMark: SyntaxNode | null;
  taskMark: SyntaxNode | null;
  quoteMarks: SyntaxNode[];
  /** An ATX heading's opening `#`s. */
  headerMark: SyntaxNode | null;
  /** The kind of list item this line starts. */
  list: ListKind | null;
  /** Where the line's text starts, past all of its block syntax. */
  content: number;
  /** Code, a table, HTML, frontmatter, a footnote's source: not prose. */
  skip: boolean;
}

function lineInfo(state: EditorState, tree: Tree, line: Line): LineInfo {
  const info: LineInfo = { line, block: null, first: false, listMark: null, taskMark: null, quoteMarks: [], headerMark: null, list: null, content: line.from, skip: false };
  const on = (n: { from: number; to: number }) => n.from >= line.from && n.to <= line.to;
  tree.iterate({
    from: line.from, to: line.to,
    enter: (n) => {
      if (n.to < line.from || n.from > line.to) return false;
      if (NOT_PROSE.test(n.name) || isFootnote(state, n)) { info.skip = true; return false; }
      if (TEXTBLOCK.test(n.name)) {
        // A setext heading's underline is syntax, not text.
        const underline = n.name.startsWith("SetextHeading") ? n.node.lastChild : null;
        if (underline && line.from >= state.doc.lineAt(underline.from).from) { info.skip = true; return false; }
        info.block = n.node;
        info.first = n.from >= line.from;
      }
      switch (n.name) {
        case "ListMark":
          if (on(n)) {
            info.listMark = n.node;
            const item = n.node.parent;
            info.list = item?.getChild("Task") ? "task" : item?.parent?.name === "OrderedList" ? "ordered" : "bullet";
          }
          return false;
        case "TaskMarker": if (on(n)) info.taskMark = n.node; return false;
        case "QuoteMark": if (on(n)) info.quoteMarks.push(n.node); return false;
        case "HeaderMark":
          if (on(n) && n.node.parent?.name.startsWith("ATXHeading") && n.node.parent.firstChild?.from === n.from) info.headerMark = n.node;
          return false;
      }
      return;
    },
  });
  let content = line.from;
  for (const m of [...info.quoteMarks, info.listMark, info.taskMark, info.headerMark]) if (m) content = Math.max(content, m.to);
  while (content < line.to && (line.text[content - line.from] === " " || line.text[content - line.from] === "\t")) content++;
  info.content = content;
  return info;
}

/** The lines the selection covers; a range ending at the start of a line does not take that line. */
function selectedLines(state: EditorState): Line[] {
  const seen = new Set<number>();
  const out: Line[] = [];
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    let last = state.doc.lineAt(r.to).number;
    if (r.to > r.from && state.doc.line(last).from === r.to && last > first) last--;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(state.doc.line(n));
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

function headingLevel(block: SyntaxNode | null): number {
  const m = block && /^(?:ATX|Setext)Heading([1-6])$/.exec(block.name);
  return m ? Number(m[1]) : 0;
}

/** A single caret on a line holding no text: a new paragraph, where a style applies to what is typed next. */
function emptyCaretLine(state: EditorState, info: LineInfo): boolean {
  const sel = state.selection;
  return sel.ranges.length === 1 && sel.main.empty && !info.skip && !info.block && info.content === info.line.to;
}

/** The changes that make `info`'s heading, or paragraph line, a heading of `level`; 0 is body text. */
function headingChanges(state: EditorState, info: LineInfo, level: number): ChangeSpec[] {
  const doc = state.doc;
  const block = info.block!;
  if (info.headerMark) {
    const mark = info.headerMark;
    if (level > 0) return replace(doc, mark.from, mark.to, "#".repeat(level));
    const changes: ChangeSpec[] = [{ from: mark.from, to: info.content }];
    const close = block.lastChild;
    if (close && close.name === "HeaderMark" && close.from > mark.from) {
      changes.push({ from: trim(doc, info.content, close.from).to, to: close.to });
    }
    return changes;
  }
  if (block.name.startsWith("SetextHeading")) {
    if (!info.first || level === headingLevel(block)) return [];
    const underline = block.lastChild!;
    const changes: ChangeSpec[] = [{ from: doc.lineAt(underline.from).from - 1, to: underline.to }];
    if (level > 0) changes.push({ from: info.content, insert: `${"#".repeat(level)} ` });
    return changes;
  }
  if (block.name === "Task" || level === 0) return [];
  return [{ from: info.content, insert: `${"#".repeat(level)} ` }];
}

/**
 * Where the `\` of a hard break ending line `n` stands, or -1. A command that
 * cuts the paragraph after that line takes it away, as it would show there.
 */
function hardBreakAt(state: EditorState, tree: Tree, n: number): number {
  if (n < 1) return -1;
  const node = tree.resolveInner(state.doc.line(n).to, -1);
  return node.name === "HardBreak" && state.doc.sliceString(node.from, node.from + 1) === "\\" ? node.from : -1;
}

/**
 * Cuts a paragraph between line `n - 1` and line `n`, keeping the inline
 * formatting across the break: whatever spans it closes at the end of the
 * upper line's text and reopens at the start of the lower line's, as Enter
 * splits a paragraph (RICH-19), so `**an important\nphrase**` cut there is
 * `**an important**` and `**phrase**`. `close` is the change at the upper
 * line's end, which also takes away a hard break's `\`, as it would show
 * there; `opens` is what the lower line's text starts with. Null when what
 * spans the break cannot close and reopen: an image, an HTML tag, a link's
 * destination.
 */
function lineCut(state: EditorState, tree: Tree, n: number): { close: ChangeSpec | null; opens: string } | null {
  const doc = state.doc;
  const above = doc.line(n - 1);
  const hard = hardBreakAt(state, tree, n - 1);
  let end = hard >= 0 ? hard : above.to;
  while (hard < 0 && end > above.from && isSpace(doc.sliceString(end - 1, end))) end--;
  const spans: { open: string; close: string }[] = [];
  let cuttable = true;
  // The constructs holding the line break, outer before inner.
  tree.iterate({
    from: above.to,
    to: above.to + 1,
    enter: (node) => {
      if (!cuttable || node.from > above.to || node.to <= above.to) return false;
      if (node.type.is("Block")) return undefined;
      if (node.name === "HardBreak") return false;
      const text = /^(Emphasis|StrongEmphasis|Strikethrough|InlineCode|Link)$/.test(node.name) ? textSpan(node.node, doc) : null;
      if (text && text.from > node.from && text.from <= above.to && text.to > above.to) {
        spans.push({ open: doc.sliceString(node.from, text.from), close: doc.sliceString(text.to, node.to) });
        return undefined;
      }
      cuttable = false;
      return false;
    },
  });
  if (!cuttable) return null;
  const closes = spans.map((s) => s.close).reverse().join("");
  const close = closes || hard >= 0 ? { from: end, to: hard >= 0 ? hard + 1 : end, insert: closes } : null;
  return { close, opens: spans.map((s) => s.open).join("") };
}

/**
 * The changes that cut paragraphs before each line number in `cuts`
 * (`lineCut`), and what each of those lines' text starts with after them;
 * null when one cannot be cut.
 */
function cutLines(state: EditorState, tree: Tree, cuts: Iterable<number>): { changes: ChangeSpec[]; opens: Map<number, string> } | null {
  const changes: ChangeSpec[] = [];
  const opens = new Map<number, string>();
  for (const n of new Set(cuts)) {
    const cut = lineCut(state, tree, n);
    if (!cut) return null;
    if (cut.close) changes.push(cut.close);
    if (cut.opens) opens.set(n, cut.opens);
  }
  return { changes, opens };
}

/**
 * Makes each line of the selection a heading of `level`, or body text for 0,
 * writing only the `#`s before it (RICH-05). A setext heading becomes an ATX
 * one, since only its underline says its level. A line of a paragraph cut
 * out as a heading takes the hard breaks on either side of it with it, and
 * formatting across either break closes and reopens there (`lineCut`). Null,
 * and no change, when the text would read otherwise (`blockChecked`).
 */
export function setHeading(state: EditorState, level: number): TransactionSpec | null {
  const tree = treeOf(state);
  const infos = selectedLines(state).map((line) => lineInfo(state, tree, line));
  const heads = new Set(infos.filter((i) => i.block && level > 0 && i.block.name === "Paragraph"));
  const cuts: number[] = [];
  for (const i of heads) {
    if (!i.first) cuts.push(i.line.number);
    if (i.block!.to > i.line.to) cuts.push(i.line.number + 1);
  }
  const cut = cutLines(state, tree, cuts);
  if (!cut) return null;
  const changes = cut.changes;
  const opened = new Set<number>();
  for (const info of infos) {
    if (info.block) {
      const own = headingChanges(state, info, level);
      // A paragraph line's one change is the `#`s written before its text, which the formatting it reopens follows.
      const opens = heads.has(info) ? cut.opens.get(info.line.number) : undefined;
      if (opens) {
        opened.add(info.line.number);
        changes.push({ from: info.content, insert: `${"#".repeat(level)} ${opens}` });
      } else changes.push(...own);
    } else if (level > 0 && emptyCaretLine(state, info)) changes.push({ from: info.content, insert: `${"#".repeat(level)} ` });
  }
  // The rest of a paragraph after a heading reopens its formatting too.
  for (const [n, opens] of cut.opens) if (!opened.has(n)) changes.push({ from: lineInfo(state, tree, state.doc.line(n)).content, insert: opens });
  return blockCommit(state, tree, changes);
}

/**
 * A line a list or quote command acts on: prose holding text or an item's
 * marker. A setext heading's underline cannot follow its text into an item or
 * a quote, so the heading is left alone.
 */
function listable(i: LineInfo): boolean {
  return !i.skip && !!(i.block || i.listMark) && !i.block?.name.startsWith("SetextHeading");
}

/** Where a line with no marker of its own would take one: after its quote marks, at the column of the item it continues. */
function markerSite(state: EditorState, info: LineInfo): { from: number; indent: string } {
  const quote = info.quoteMarks[info.quoteMarks.length - 1];
  let from = quote ? quote.to : info.line.from;
  if (quote && info.line.text[from - info.line.from] === " ") from++;
  let indent = "";
  for (let n = info.block?.parent ?? null; n; n = n.parent) {
    if (n.name !== "ListItem") continue;
    const mark = n.getChild("ListMark");
    if (mark) {
      const markLine = state.doc.lineAt(mark.from);
      const markQuote = /^(?:[ \t]*>[ \t]?)*/.exec(markLine.text)![0].length;
      indent = " ".repeat(Math.max(0, mark.from - markLine.from - markQuote));
    }
    break;
  }
  return { from, indent };
}

/**
 * A blank line before `line`, carrying the quote marks that stand before
 * `mark` on it: it parts the text there from the lines above, which would
 * take it in.
 */
function partBefore(doc: Text, line: Line, mark: number): ChangeSpec {
  return { from: line.from, insert: `${doc.sliceString(line.from, mark).trimEnd()}\n` };
}

/** Whether an item marked `mark`, with `rest` after it, cannot start a list after a paragraph: a numbered one not counting from 1, or an empty one. */
function cannotInterrupt(mark: string, rest: string): boolean {
  return (/^\d/.test(mark) && !/^1[.)]$/.test(mark)) || !rest.trim();
}

/** The marker of the item after `item` in its list, past the `>` a quote puts between them; null for the last. */
function nextMark(item: SyntaxNode | null | undefined): SyntaxNode | null {
  let next = item?.nextSibling;
  while (next?.name === "QuoteMark") next = next.nextSibling;
  return next?.name === "ListItem" ? next.getChild("ListMark") : null;
}

/** Which list an item marked `mark` belongs to: items of one list share a bullet character, or a numbered item's `.` or `)`. */
const listType = (mark: string) => (/^\d/.test(mark) ? mark.slice(-1) : mark);

/**
 * Makes each line of the selection an item of `kind`, or, when every one
 * already is, plain text again (RICH-06). A line is what rich mode shows as
 * one: an agent's line break inside a paragraph shows as a break (§7), so each
 * line becomes its own item, and turning the items back gives the same lines.
 * A bullet is `-`, a checklist item `- [ ]`, a numbered item counts from 1. A
 * line cut out of a paragraph takes the hard break before it with it, and
 * formatting across the break closes and reopens there (`lineCut`). A
 * heading keeps its `#`s after a bullet or a number; a checklist item holds
 * only text, so one made of a heading drops them. The list an item leaves
 * stays whole: an item after it that could not start a list after it — a
 * numbered one not counting from 1, an empty one — is parted from it by a
 * blank line, as it would otherwise be read as its text; and text taken out
 * of a list is parted by one from an item above it. Null, and no change,
 * when the text would read otherwise all the same (`blockChecked`).
 */
export function toggleList(state: EditorState, kind: ListKind): TransactionSpec | null {
  const doc = state.doc;
  const tree = treeOf(state);
  const infos = selectedLines(state).map((l) => lineInfo(state, tree, l));
  const lines = infos.filter(listable);
  const prefix = (n: number) => (kind === "bullet" ? "- " : kind === "ordered" ? `${n}. ` : "- [ ] ");
  const done = (changes: ChangeSpec[]) => blockCommit(state, tree, changes);
  if (!lines.length) {
    const only = infos.length === 1 ? infos[0] : null;
    return only && emptyCaretLine(state, only) ? done([{ from: only.content, insert: prefix(1) }]) : null;
  }
  const chosen = new Set(lines.map((i) => i.line.number));
  // The item after `item` in its list, when it is not chosen and could not
  // start a list after what `item` becomes: a paragraph, or an item marked
  // `mark` of another list.
  const apart = (item: SyntaxNode | null, mark: string | null): ChangeSpec[] => {
    const next = nextMark(item);
    if (!next) return [];
    const line = doc.lineAt(next.from);
    const text = doc.sliceString(next.from, next.to);
    if (chosen.has(line.number) || (mark !== null && listType(mark) === listType(text))) return [];
    return cannotInterrupt(text, doc.sliceString(next.to, line.to)) ? [partBefore(doc, line, next.from)] : [];
  };
  const changes: ChangeSpec[] = [];
  if (lines.every((i) => i.list === kind)) {
    for (const i of lines) {
      const mark = i.listMark!;
      const n = i.line.number;
      const above = n > 1 && !chosen.has(n - 1) ? lineInfo(state, tree, doc.line(n - 1)) : null;
      if (above && !/^[\s>]*$/.test(above.line.text) && (above.listMark || (above.block && ancestorOf(above.block, "ListItem")))) {
        changes.push(partBefore(doc, i.line, mark.from));
      }
      changes.push({ from: mark.from, to: i.headerMark ? i.headerMark.from : i.content }, ...apart(mark.parent, null));
    }
    return done(changes);
  }
  const cut = cutLines(state, tree, lines.filter((i) => i.block?.name === "Paragraph" && !i.first).map((i) => i.line.number));
  if (!cut) return null;
  changes.push(...cut.changes);
  // Items already of the kind keep their bytes; the numbering of new ones
  // carries on from a numbered item among them.
  let n = 0;
  for (const i of lines) {
    const mark = i.listMark ? doc.sliceString(i.listMark.from, i.listMark.to) : "";
    if (i.list === kind) {
      if (kind === "ordered") n = parseInt(mark, 10) || n + 1;
      continue;
    }
    n++;
    const end = i.headerMark && kind !== "task" ? i.headerMark.from : i.content;
    if (i.listMark) {
      // A bullet keeps its `*` or `+` on its way to a checklist and back.
      const bullet = /^[-*+]$/.test(mark) ? mark : "-";
      const insert = kind === "ordered" ? prefix(n) : kind === "bullet" ? `${bullet} ` : `${bullet} [ ] `;
      changes.push(...replace(doc, i.listMark.from, end, insert), ...apart(i.listMark.parent, kind === "ordered" ? `${n}.` : bullet));
    } else {
      const site = markerSite(state, i);
      changes.push(...replace(doc, site.from, end, site.indent + prefix(n) + (cut.opens.get(i.line.number) ?? "")));
    }
    const close = i.block?.lastChild;
    if (kind === "task" && i.headerMark && close?.name === "HeaderMark" && close.from > i.headerMark.from) {
      changes.push({ from: trim(doc, i.content, close.from).to, to: close.to });
    }
  }
  return done(changes);
}

function inQuote(info: LineInfo): boolean {
  if (info.quoteMarks.length) return true;
  for (let n = info.block?.parent ?? null; n; n = n.parent) if (n.name === "Blockquote") return true;
  return false;
}

/** The innermost `>` on a line, with the space after it. */
function quoteMarkChange(info: LineInfo): ChangeSpec[] {
  const q = info.quoteMarks[info.quoteMarks.length - 1];
  if (!q) return [];
  const space = info.line.text[q.to - info.line.from] === " " ? 1 : 0;
  return [{ from: q.from, to: q.to + space }];
}

/** `changes`, a block command's, committed when `blockChecked` passes them; `caret` places the caret after them. */
function blockCommit(state: EditorState, tree: Tree, changes: ChangeSpec[], caret?: (set: ChangeSet) => number): TransactionSpec | null {
  const set = blockChecked(state, tree, changes);
  return set && commit(state, set, caret ? EditorSelection.cursor(caret(set)) : undefined);
}

/**
 * Quotes each paragraph the selection touches, all its lines, or unquotes
 * them when every one is quoted already (RICH-06). Null, and no change,
 * when the text would read otherwise (`blockChecked`).
 */
export function toggleQuote(state: EditorState): TransactionSpec | null {
  const doc = state.doc;
  const tree = treeOf(state);
  const numbers = new Set<number>();
  const infos: LineInfo[] = [];
  const add = (line: Line) => {
    if (numbers.has(line.number)) return;
    numbers.add(line.number);
    infos.push(lineInfo(state, tree, line));
  };
  for (const line of selectedLines(state)) {
    const info = lineInfo(state, tree, line);
    if (info.block) {
      for (let pos = info.block.from; pos <= info.block.to; pos = doc.lineAt(pos).to + 1) add(doc.lineAt(pos));
    } else add(line);
  }
  const lines = infos.filter(listable);
  if (!lines.length) {
    const only = infos.length === 1 ? infos[0] : null;
    return only && emptyCaretLine(state, only) ? blockCommit(state, tree, [{ from: only.line.from, insert: "> " }]) : null;
  }
  const changes: ChangeSpec[] = [];
  if (lines.every(inQuote)) for (const i of lines) changes.push(...quoteMarkChange(i));
  else for (const i of lines) if (!inQuote(i)) changes.push({ from: i.line.from, insert: "> " });
  return blockCommit(state, tree, changes);
}

/** The innermost list item or quote holding a line's text, or null at the top level. */
function containerOf(tree: Tree, info: LineInfo): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree.resolveInner(info.content, info.content < info.line.to ? 1 : -1); n; n = n.parent) {
    if (n.name === "ListItem" || n.name === "Blockquote") return n;
  }
  return null;
}

/**
 * Wraps the selected lines in a fenced code block, or, with the caret in a
 * fenced block, takes its fences away. On an empty line it starts an empty
 * block with the caret inside. In a list item or a quote the block goes
 * inside it: the fences sit after its marker, and every line of the block
 * carries the quote's `>` or the item's indentation. Lines of two items or
 * quotes, a table's rows, a checklist item and what is not prose take none.
 */
export function toggleCodeBlock(state: EditorState): TransactionSpec | null {
  const doc = state.doc;
  const tree = treeOf(state);
  const sel = state.selection.main;
  const fenced = ancestor(tree, sel.head, "FencedCode");
  if (fenced) {
    const open = doc.lineAt(fenced.from);
    const last = fenced.lastChild;
    const close = last?.name === "CodeMark" && last.from > open.to ? doc.lineAt(last.from) : null;
    const lead = doc.sliceString(open.from, fenced.from);
    const changes: ChangeSpec[] = [];
    if (/^[ \t>]*$/.test(lead)) changes.push({ from: open.from, to: Math.min(doc.length, open.to + 1) });
    else {
      // The fence follows a list item's marker, and the first line of code takes its place there.
      const next = open.number < doc.lines ? doc.line(open.number + 1) : null;
      if (!next || next.number === close?.number) return commit(state, [{ from: fenced.from, to: next ? next.to : open.to }]);
      changes.push({ from: fenced.from, to: next.from + Math.min(lead.length, /^[ \t>]*/.exec(next.text)![0].length) });
    }
    if (close) changes.push({ from: close.from - 1, to: close.to });
    return commit(state, changes);
  }
  if (ancestor(tree, sel.head, "CodeBlock")) return null;
  const first = doc.lineAt(sel.from);
  let last = doc.lineAt(sel.to);
  if (sel.to > sel.from && last.from === sel.to && last.number > first.number) last = doc.line(last.number - 1);
  const infos: LineInfo[] = [];
  for (let n = first.number; n <= last.number; n++) infos.push(lineInfo(state, tree, doc.line(n)));
  const box = containerOf(tree, infos[0]);
  const same = (n: SyntaxNode | null) => n?.from === box?.from && n?.name === box?.name;
  if (infos.some((i) => i.skip || i.taskMark || !same(containerOf(tree, i)))) return null;
  let open: { from: number; to: number; insert: string } = { from: first.from, to: first.from, insert: "```\n" };
  const changes: ChangeSpec[] = [];
  let prefix = "";
  if (box) {
    // What starts a new line inside the container: its first line up to its
    // text, with an item's marker blanked out.
    const markLine = doc.lineAt(box.from);
    const mark = box.firstChild;
    let text = mark ? mark.to : box.from;
    for (let n = 0; n < (box.name === "ListItem" ? 4 : 1) && doc.sliceString(text, text + 1) === " "; n++) text++;
    prefix = doc.sliceString(markLine.from, text).replace(/[^ \t>]/g, " ");
    infos.forEach((i, k) => {
      const onMark = i.line.number === markLine.number;
      const q = i.quoteMarks[i.quoteMarks.length - 1];
      let t = onMark ? text : q ? q.to : i.line.from;
      if (!onMark) while (t < i.line.to && /[ \t]/.test(doc.sliceString(t, t + 1))) t++;
      const have = doc.sliceString(i.line.from, t);
      const fits = onMark || have === prefix;
      if (k === 0) open = fits ? { from: t, to: t, insert: "```\n" + prefix } : { from: i.line.from, to: t, insert: prefix + "```\n" + prefix };
      // A blank line keeps the quote's `>`, and needs no indentation.
      else if (!fits && !(t === i.line.to && have.trimEnd() === prefix.trimEnd())) changes.push({ from: i.line.from, to: t, insert: t === i.line.to ? prefix.trimEnd() : prefix });
    });
  }
  changes.unshift(open);
  changes.push({ from: last.to, insert: "\n" + prefix + "```" });
  // The selection stays on the lines, inside the new fences.
  const set = state.changes(changes);
  const start = set.mapPos(open.from, -1) + open.insert.length;
  const inside = (pos: number) => (pos <= open.to ? start : set.mapPos(pos, -1));
  return commit(state, changes, EditorSelection.range(inside(sel.anchor), inside(sel.head)));
}

/**
 * Backspace at the very start of a heading, list item, checklist item or
 * quote takes that formatting off and leaves the text where it is; at the
 * start of a plain paragraph it joins the paragraph to the one above
 * (RICH-07). Null anywhere else, for the ordinary Backspace, and where the
 * text would read otherwise after it (`blockChecked`): joined, a plain `` ` ``
 * or `*` could pair with one in the text above.
 */
export function backspaceBlock(state: EditorState): TransactionSpec | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return null;
  const pos = sel.main.head;
  const doc = state.doc;
  const tree = treeOf(state);
  const info = lineInfo(state, tree, doc.lineAt(pos));
  if (info.skip || pos > info.content) return null;
  const block = info.block;
  if (block && info.first && (info.headerMark || block.name.startsWith("SetextHeading"))) {
    return blockCommit(state, tree, headingChanges(state, info, 0));
  }
  const quote = info.quoteMarks[info.quoteMarks.length - 1];
  if (info.listMark && (!quote || info.listMark.from > quote.from)) {
    const changes: ChangeSpec[] = [{ from: info.listMark.from, to: info.content }];
    // The item's text becomes a paragraph of its own: a blank line, with any
    // quote's `>`, parts it from a line above that would take it in, and from
    // a next item that cannot start a list after a paragraph — a numbered one
    // not counting from 1, or an empty one.
    const above = info.line.number > 1 ? doc.line(info.line.number - 1) : null;
    if (info.content < info.line.to && above && !/^[\s>]*$/.test(above.text)) changes.unshift(partBefore(doc, info.line, info.listMark.from));
    const next = nextMark(info.listMark.parent);
    if (next) {
      const line = doc.lineAt(next.from);
      if (cannotInterrupt(doc.sliceString(next.from, next.to), doc.sliceString(next.to, line.to))) changes.push(partBefore(doc, line, next.from));
    }
    return blockCommit(state, tree, changes, (set) => set.mapPos(info.content, 1));
  }
  if (quote && (info.first || !block)) {
    const changes: ChangeSpec[] = [];
    if (!block) changes.push(...quoteMarkChange(info));
    else for (let p = block.from; p <= block.to; p = doc.lineAt(p).to + 1) changes.push(...quoteMarkChange(lineInfo(state, tree, doc.lineAt(p))));
    return blockCommit(state, tree, changes);
  }
  if (!block || !info.first || block.name !== "Paragraph") return null;
  // Join: the gap back to the text above may hold blank lines and a quote's
  // empty `>` lines, and nothing else.
  let n = info.line.number - 1;
  while (n >= 1 && /^[\s>]*$/.test(doc.line(n).text)) n--;
  if (n < 1) return null;
  const above = lineInfo(state, tree, doc.line(n));
  if (above.skip || !above.block || above.block.name.startsWith("SetextHeading")) return null;
  let end = above.line.to;
  const close = above.block.lastChild;
  if (above.headerMark && close?.name === "HeaderMark" && close.from > above.headerMark.from) end = close.from;
  end = Math.max(above.content, trim(doc, above.content, end).to);
  const changes: ChangeSpec[] = [{ from: end, to: info.content }];
  // A heading holds one line: the rest of the paragraph stays a paragraph,
  // cut from the line joined as `setHeading` cuts one (`lineCut`).
  if (above.headerMark && block.to > info.line.to) {
    const cut = lineCut(state, tree, info.line.number + 1);
    if (!cut) return null;
    if (cut.close) changes.push(cut.close);
    if (cut.opens) changes.push({ from: lineInfo(state, tree, doc.line(info.line.number + 1)).content, insert: cut.opens });
  }
  return blockCommit(state, tree, changes, (set) => set.mapPos(end, -1));
}

// --- Links (RICH-09) ---------------------------------------------------------

export interface LinkInfo {
  from: number;
  to: number;
  /** The link's text, between its brackets. */
  textFrom: number;
  textTo: number;
  /** The destination, when the link has one written inline. */
  urlFrom: number | null;
  urlTo: number | null;
  text: string;
  url: string;
}

/** The link the selection is inside, or null. A caret at either outer edge is outside it. */
export function linkAt(state: EditorState, from: number, to: number, tree = treeOf(state)): LinkInfo | null {
  const n = ancestor(tree, from, "Link");
  if (!n || from < n.from || to > n.to || (from === to && (from === n.from || from === n.to))) return null;
  const p = linkParts(n, state.doc);
  if (!p) return null;
  const doc = state.doc;
  return {
    from: n.from, to: n.to, textFrom: p.open.to, textTo: p.close.from,
    urlFrom: p.url?.from ?? null, urlTo: p.url?.to ?? null,
    text: doc.sliceString(p.open.to, p.close.from),
    url: p.url ? doc.sliceString(p.url.from, p.url.to) : "",
  };
}

const ENCODE: Record<string, string> = { " ": "%20", "\t": "%09", "\n": "%0A", "(": "%28", ")": "%29", "<": "%3C", ">": "%3E", "|": "%7C", "\\": "%5C" };

/**
 * A target as a link destination: the characters that would end one, a
 * pipe, which would end a table cell, and a backslash, which would escape
 * the character after it or the `)`, are percent-encoded, as a pasted file's
 * link has them.
 */
export function destination(target: string): string {
  return target.trim().replace(/[\s()<>|\\]/g, (c) => ENCODE[c] ?? encodeURIComponent(c));
}

/**
 * Text as written between a link's brackets: a bracket, or in a table a pipe,
 * that would end the link or its cell is escaped, one escaped already is left
 * as it is, and a trailing backslash is escaped so it cannot take the `]`. So
 * is a backtick run that no run of its length after it closes inside the
 * text, which would open a code span past the link's end.
 */
function linkText(text: string, cell: boolean): string {
  const runs = [...text.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  const open = new Set<number>();
  for (let i = 0; i < runs.length; i++) {
    const close = runs.findIndex((r, k) => k > i && r.len === runs[i].len);
    if (close >= 0) i = close;
    else for (let p = runs[i].at; p < runs[i].at + runs[i].len; p++) open.add(p);
  }
  let out = "";
  let slashes = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "[" || ch === "]" || (cell && ch === "|") || open.has(i)) && slashes % 2 === 0) out += "\\";
    out += ch;
    slashes = ch === "\\" ? slashes + 1 : 0;
  }
  return slashes % 2 ? `${out}\\` : out;
}

const inTable = (state: EditorState, pos: number) => !!ancestor(treeOf(state), pos, "Table");

/**
 * Whether Ctrl+K has a link to write or edit at `from`–`to`: a selection
 * holding text, or a caret where rich mode edits text (`prose`). Code,
 * frontmatter and what rich mode shows as source have none.
 */
export function linkable(state: EditorState, from: number, to: number): boolean {
  const tree = treeOf(state);
  return from === to ? prose(state, tree, from) : inlineSpans(state, tree, from, to).length > 0;
}

/**
 * `insert`, a link, written at `pos` on a line holding no text, when a fresh
 * parse reads it as a paragraph of its own and nothing more: not taken in by
 * the paragraph or item above it, not taking in the line below, not a
 * heading over a `---`.
 */
function alone(state: EditorState, tree: Tree, pos: number, insert: string): ChangeSet | null {
  const set = state.changes({ from: pos, insert });
  const fresh = reparse(state, tree, set);
  let para: SyntaxNode | null = fresh ? fresh.tree.resolveInner(pos, 1) : null;
  while (para && para.name !== "Paragraph") para = para.parent;
  const link = para?.firstChild;
  return para && para.from === pos && para.to === pos + insert.length && link?.name === "Link" && link.to === para.to ? set : null;
}

/**
 * Writes `[text](target)` over `from`–`to`: the range becomes the link's
 * text, widened as emphasis is so the brackets cut nothing. An empty range
 * inserts the link, its text `text` or else the target: typed into text, it
 * is checked against what stands beside it (`checked`); on a line holding
 * no text it must be a paragraph of its own, which a line of text next to
 * it, or a `---` under it, would not let it be. Nothing is written in code,
 * frontmatter or what rich mode shows as source. The caret goes after the
 * link, where typing is plain text again (RICH-03).
 */
export function insertLink(state: EditorState, from: number, to: number, target: string, text = ""): TransactionSpec | null {
  const dest = destination(target);
  if (!dest) return null;
  const tree = treeOf(state);
  if (from === to) {
    if (!prose(state, tree, from)) return null;
    const insert = `[${linkText(text || target.trim(), inTable(state, from))}](${dest})`;
    const set = leafAt(tree, from)
      ? checked(state, tree, [{ from, insert }], { name: `Link(${dest})`, on: true, must: [], free: [], replaced: { from, to: from } })
      : alone(state, tree, from, insert);
    return set && commit(state, set, EditorSelection.cursor(set.mapPos(from, -1) + insert.length));
  }
  const span = inlineSpans(state, tree, from, to)[0];
  if (!span) return null;
  const t = trim(state.doc, span.from, span.to);
  if (t.from >= t.to) return null;
  const r = balance(state, tree, t.from, t.to, null);
  // A link holds no link.
  if (nodesNamed(tree, "Link", r.from, r.to).some((n) => n.from >= r.from && n.to <= r.to)) return null;
  const tail = `](${dest})`;
  const set = checked(state, tree, [{ from: r.from, insert: "[" }, { from: r.to, insert: tail }], {
    name: `Link(${dest})`, on: true, must: [t], free: [r], drops: (name) => BARE.has(name),
  });
  return set && commit(state, set, EditorSelection.cursor(set.mapPos(r.to, -1) + tail.length));
}

/** Rewrites a link's text and target, each only where it changed; an empty target removes the link. */
export function updateLink(state: EditorState, link: LinkInfo, text: string, target: string): TransactionSpec | null {
  if (!target.trim()) return removeLink(state, link);
  const doc = state.doc;
  const changes: Change[] = [];
  if (text && text !== link.text) changes.push(...replace(doc, link.textFrom, link.textTo, linkText(text, inTable(state, link.from))));
  const dest = target.trim() !== link.url ? destination(target) : link.url;
  if (dest !== link.url) {
    if (link.urlFrom !== null && link.urlTo !== null) changes.push(...replace(doc, link.urlFrom, link.urlTo, dest));
    // A reference link, `[text][ref]` or `[text]`, takes an inline destination in place of its label.
    else changes.push(...replace(doc, link.textTo + 1, link.to, `(${dest})`));
  }
  // The link written afresh has to read as one, and nothing around it change.
  const set = checked(state, treeOf(state), changes, { name: `Link(${dest})`, on: true, must: [], free: [], replaced: link });
  return set && commit(state, set, EditorSelection.cursor(set.mapPos(link.to, 1)));
}

/** Takes the link away and keeps its text. */
export function removeLink(state: EditorState, link: LinkInfo): TransactionSpec | null {
  const set = checked(state, treeOf(state), [{ from: link.from, to: link.textFrom }, { from: link.textTo, to: link.to }], {
    name: link.urlFrom === null ? "Link" : `Link(${link.url})`, on: false, must: [{ from: link.textFrom, to: link.textTo }], free: [link],
  });
  return set && commit(state, set);
}

// --- What the toolbar shows (RICH-10) ---------------------------------------

export interface FormatState {
  marks: Record<Mark, boolean>;
  /** The heading level of the caret's line, 0 for body text. */
  heading: number;
  /** The list kind every selected line shares, or null. */
  list: ListKind | null;
  quote: boolean;
  codeBlock: boolean;
  link: boolean;
}

/** Past this many lines a selection marks nothing pressed: the toolbar reads it on every keystroke. */
const STATE_LINES = 200;

/**
 * The formatting the selection has, as the toolbar marks it pressed: a mark
 * the whole selection carries, or the caret's place carries or is pending.
 * It reads the tree as far as it is parsed, never waiting for more.
 */
export function formatState(state: EditorState): FormatState {
  const tree = syntaxTree(state);
  const sel = state.selection.main;
  const doc = state.doc;
  const small = doc.lineAt(sel.to).number - doc.lineAt(sel.from).number < STATE_LINES;
  const pending = state.field(pendingField, false);
  const marks = {} as Record<Mark, boolean>;
  const spans = sel.empty || !small ? [] : inlineSpans(state, tree, sel.from, sel.to);
  for (const m of MARKS) {
    marks[m] = sel.empty
      ? (pending && pending.pos === sel.head ? pending.marks[m] : undefined) ?? activeAt(state, tree, m, sel.head)
      : covered(state, tree, m, spans);
  }
  const infos = small ? selectedLines(state).map((l) => lineInfo(state, tree, l)).filter(listable) : [];
  const kind = infos[0]?.list ?? null;
  return {
    marks,
    heading: headingLevel(lineInfo(state, tree, doc.lineAt(sel.head)).block),
    list: infos.length && infos.every((i) => i.list === kind) ? kind : null,
    quote: infos.length > 0 && infos.every(inQuote),
    codeBlock: !!ancestor(tree, sel.head, "FencedCode") || !!ancestor(tree, sel.head, "CodeBlock"),
    link: !!linkAt(state, sel.from, sel.to, tree),
  };
}

// --- Copying (RICH-17) -------------------------------------------------------

/**
 * `from`–`to` as Markdown that stands on its own: a selection starting or
 * ending inside emphasis, a code span or a link gets the syntax it cut off,
 * so `bold` copied out of `**a bold word**` is `**bold**`. With `block`, one
 * starting where a line's text starts takes the line's `#`, `-` or `>` too.
 * Otherwise it is the text selected: part of a web address, an autolink or
 * an HTML tag is that part, since a cut or a drag removes only that much
 * (`deletion` in `rich.ts`) and carrying the whole would write the rest
 * twice. An escape's backslash goes with the character after it, and a hard
 * break's with its line break, as `deletion` takes them.
 */
function markdownOf(state: EditorState, tree: Tree, from: number, to: number, block = true): { text: string; from: number; to: number } {
  const doc = state.doc;
  const first = lineInfo(state, tree, doc.lineAt(from));
  if (block && !first.skip && from <= first.content) from = first.line.from;
  let prefix = "";
  let suffix = "";
  const bounds = (n: SyntaxNode): { open: Span; close: Span } | null => {
    if (n.name === "Link") {
      const p = linkParts(n, doc);
      return p ? { open: { from: n.from, to: p.open.to }, close: { from: p.close.from, to: n.to } } : null;
    }
    return n.name === "Emphasis" || n.name === "StrongEmphasis" || n.name === "Strikethrough" || n.name === "InlineCode" ? delimiters(n) : null;
  };
  const glued = (n: SyntaxNode) => n.name === "Escape" || n.name === "HardBreak";
  for (let n: SyntaxNode | null = tree.resolveInner(from, 1); n && !INLINE_CONTAINER.test(n.name); n = n.parent) {
    if (!(n.from < from && from < n.to)) continue;
    const d = bounds(n);
    if (!d) { if (glued(n) || SYNTAX.has(n.name)) from = n.from; continue; }
    if (from <= d.open.to) from = n.from;
    else if (from >= d.close.from) from = n.to;
    else prefix = doc.sliceString(d.open.from, d.open.to) + prefix;
  }
  for (let n: SyntaxNode | null = tree.resolveInner(to, -1); n && !INLINE_CONTAINER.test(n.name); n = n.parent) {
    if (!(n.from < to && to < n.to)) continue;
    const d = bounds(n);
    if (!d) {
      if (glued(n)) to = n.from;
      else if (SYNTAX.has(n.name)) to = n.to;
      continue;
    }
    if (to >= d.close.from) to = n.to;
    else if (to <= d.open.to) to = n.from;
    else suffix += doc.sliceString(d.close.from, d.close.to);
  }
  return { text: prefix + doc.sliceString(from, Math.max(from, to)) + suffix, from, to: Math.max(from, to) };
}

const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITY[c]);
/** Only a web or mail address becomes a link in HTML that leaves the application. */
const safeHref = (href: string) => /^(https?:|mailto:)/i.test(href);

/**
 * `from`–`to` as HTML, built by walking the syntax tree. Every piece of
 * document text is escaped on its way in; nothing from the document is ever
 * passed through as markup, and a link keeps its target only when that is a
 * web or mail address.
 */
function htmlOf(state: EditorState, tree: Tree, from: number, to: number): string {
  const doc = state.doc;
  const out: string[] = [];
  const clip = (a: number, b: number) => doc.sliceString(Math.max(a, from), Math.max(Math.max(a, from), Math.min(b, to)));
  const text = (a: number, b: number, breaks = true) => {
    const s = escapeHtml(clip(a, b));
    if (s) out.push(breaks ? s.replace(/\n[ \t]*/g, "<br>") : s.replace(/\n/g, " "));
  };
  const wrap = (tag: string, inner: () => void) => { out.push(`<${tag}>`); inner(); out.push(`</${tag}>`); };
  const within = (n: SyntaxNode) => n.to > from && n.from < to;

  const inline = (n: SyntaxNode, a: number, b: number) => {
    let pos = a;
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.to <= a || c.from >= b) continue;
      text(pos, c.from);
      pos = c.to;
      if (c.name === "QuoteMark" && doc.sliceString(c.to, c.to + 1) === " ") pos++;
      if (within(c)) inlineNode(c);
    }
    text(pos, b);
  };
  const inlineNode = (c: SyntaxNode) => {
    switch (c.name) {
      case "Emphasis": case "StrongEmphasis": case "Strikethrough": {
        const d = delimiters(c);
        const tag = c.name === "Emphasis" ? "em" : c.name === "StrongEmphasis" ? "strong" : "del";
        if (d) wrap(tag, () => inline(c, d.open.to, d.close.from));
        return;
      }
      case "InlineCode": {
        const d = delimiters(c);
        if (d) wrap("code", () => text(d.open.to, d.close.from, false));
        return;
      }
      case "Link": {
        const p = linkParts(c, doc);
        if (!p) return text(c.from, c.to);
        const href = p.url ? doc.sliceString(p.url.from, p.url.to).replace(/^<|>$/g, "") : "";
        if (safeHref(href)) {
          out.push(`<a href="${escapeHtml(href)}">`);
          inline(c, p.open.to, p.close.from);
          out.push("</a>");
        } else inline(c, p.open.to, p.close.from);
        return;
      }
      case "Autolink": case "URL": {
        const url = c.name === "URL" ? c : c.getChild("URL");
        const href = url ? doc.sliceString(url.from, url.to) : "";
        const full = /^www\./i.test(href) ? `https://${href}` : href;
        if (url && safeHref(full)) {
          out.push(`<a href="${escapeHtml(full)}">`);
          text(url.from, url.to);
          out.push("</a>");
        } else if (url) text(url.from, url.to);
        return;
      }
      case "Image": {
        const p = linkParts(c, doc);
        if (p) text(p.open.to, p.close.from);
        return;
      }
      case "Escape": text(c.from + 1, c.to); return;
      case "Entity": {
        const raw = doc.sliceString(c.from, c.to);
        if (c.from >= from && c.to <= to && /^&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});$/i.test(raw)) out.push(raw);
        else text(c.from, c.to);
        return;
      }
      case "HardBreak": out.push("<br>"); return;
      case "HTMLTag": if (/^<br\s*\/?>$/i.test(doc.sliceString(c.from, c.to))) out.push("<br>"); return;
      case "Citation": text(c.from, c.to); return;
    }
  };
  const blocks = (n: SyntaxNode) => { for (let c = n.firstChild; c; c = c.nextSibling) if (within(c)) block(c); };
  const block = (n: SyntaxNode) => {
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(n.name);
    if (heading) {
      const t = textOf(state, n);
      return wrap(`h${heading[1]}`, () => inline(n, t.from, t.to));
    }
    switch (n.name) {
      case "Paragraph": return wrap("p", () => inline(n, n.from, n.to));
      case "BulletList": return wrap("ul", () => blocks(n));
      case "OrderedList": {
        const start = parseInt(doc.sliceString(n.firstChild?.firstChild?.from ?? n.from, n.firstChild?.firstChild?.to ?? n.from), 10);
        out.push(Number.isFinite(start) && start !== 1 ? `<ol start="${start}">` : "<ol>");
        blocks(n);
        out.push("</ol>");
        return;
      }
      case "ListItem": return wrap("li", () => {
        const parts: SyntaxNode[] = [];
        for (let c = n.firstChild; c; c = c.nextSibling) if (c.name !== "ListMark") parts.push(c);
        for (const c of parts) {
          if (!within(c)) continue;
          if (c.name === "Task") {
            const box = c.firstChild;
            const checked = box ? /x/i.test(doc.sliceString(box.from, box.to)) : false;
            out.push(checked ? "☑ " : "☐ ");
            inline(c, textOf(state, c).from, c.to);
          } else if (c.name === "Paragraph" && parts.length === 1) inline(c, c.from, c.to);
          else block(c);
        }
      });
      case "Blockquote": return wrap("blockquote", () => blocks(n));
      case "FencedCode": case "CodeBlock": return wrap("pre", () => wrap("code", () => {
        for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === "CodeText") out.push(escapeHtml(clip(c.from, c.to)));
      }));
      case "HorizontalRule": out.push("<hr>"); return;
      case "Table": return wrap("table", () => {
        for (let row = n.firstChild; row; row = row.nextSibling) {
          if (!within(row) || (row.name !== "TableHeader" && row.name !== "TableRow")) continue;
          const cell = row.name === "TableHeader" ? "th" : "td";
          wrap("tr", () => { for (let c = row.firstChild; c; c = c.nextSibling) if (c.name === "TableCell") wrap(cell, () => inline(c, c.from, c.to)); });
        }
      });
      case "HTMLBlock": return wrap("pre", () => text(n.from, n.to, false));
    }
  };
  const top = tree.topNode;
  for (let c = top.firstChild; c; c = c.nextSibling) if (within(c)) block(c);
  return out.join("");
}

/**
 * What a copy puts on the clipboard (RICH-17): the Markdown source as plain
 * text, for an agent's prompt, and the formatting as HTML, for a word
 * processor or an email. Several ranges go one after another.
 */
export function clipboardContent(state: EditorState, ranges: readonly Span[]): { text: string; html: string } {
  const tree = treeOf(state);
  const texts: string[] = [];
  const htmls: string[] = [];
  for (const r of ranges) {
    if (r.from === r.to) continue;
    const md = markdownOf(state, tree, r.from, r.to);
    texts.push(md.text);
    htmls.push(htmlOf(state, tree, md.from, md.to));
  }
  return { text: texts.join(state.lineBreak), html: `<meta charset="utf-8">${htmls.join("")}` };
}

/**
 * The text a drag out of the rendered view carries (RICH-18): the source of
 * `from`–`to` with the inline formatting it cuts through closed or reopened,
 * so `ld** an` dragged out of `**bold** and` drops as `**ld** an`, as the
 * text left behind keeps its own marks. It lands inside a line, so it takes
 * none of the block syntax a copy takes.
 */
export function dragText(state: EditorState, from: number, to: number): string {
  return markdownOf(state, treeOf(state), from, to, false).text;
}
