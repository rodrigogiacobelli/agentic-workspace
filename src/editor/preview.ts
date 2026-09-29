// Rendering markdown in place: the syntax tree that highlights the source also
// decides what to hide, style or replace with a widget. The rendered view
// never shows the syntax; `rich.ts` decides what is hidden and where the caret
// stands, and this module draws it and binds the keys that edit it. See
// ADR-011.

import { deleteBracketPair } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { highlightingFor, syntaxTree } from "@codemirror/language";
import { Annotation, type ChangeDesc, type ChangeSet, EditorSelection, EditorState, Prec, RangeSet, type SelectionRange, StateEffect, StateField, Transaction, type Extension, type Line, type Range } from "@codemirror/state";
import { BlockWrapper, type Command, Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType, keymap } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { highlightTree } from "@lezer/highlight";
import { ChipWidget, citedPath, type CitationContext } from "./citation";
import {
  type Block, type Change, type Layout, type Obj, IMAGE, canonical, cellAt, cellBreak, cellEdge, cellMove, cellText, deleteBy, deletion, enter, exemptLines,
  caretSide, cellTail, hardBreak, infoRange, intact, isFootnote, landing, layout, layoutHolds, lineSyntax, mapLayout, mended, moveChar, moveGroup, paragraphBreakBefore, pasted,
  rowMove, runAt, settle, step, tableRow, typedRange,
} from "./rich";

/**
 * Where a path written in a document leads (ADR-015). The order gives at most
 * one location to try, so a path names one file or none.
 */
export interface Resolved {
  /** The path exactly as the document writes it: what a missing placeholder shows (AST-12). */
  written: string;
  /** The file, absolute; null for a path outside the boundary, which is never requested, and for a web address. */
  file: string | null;
  /** The same file from the workspace root, when it lies inside the workspace. A file in the worktree family has none. */
  rel: string | null;
  /** What the webview loads: an asset URL for the file, a web address as written, or null. */
  url: string | null;
  /** A missing placeholder's tooltip: the location tried, or that the path leads outside the workspace (AST-12). */
  tip: string;
}

export interface PreviewContext {
  /**
   * Where a path leads: a Markdown link's or image's target when `link`, a
   * relative one read from the note's directory; a citation's path after its
   * `@` otherwise, a relative one read from the workspace root.
   */
  resolve(path: string, link: boolean): Resolved;
  /** Whether a resolved file exists: known, or not yet (undefined) — the answer redraws the pane. */
  exists(target: Resolved): boolean | undefined;
  /** Follows a link: a web address in the browser, any other target as `resolve` reads it. */
  openLink(href: string): void;
  /** Takes a citation's path as `citedPath` gives it. A family file opens in the workspace holding it. */
  citation: CitationContext;
}

/** Something outside the document changed what it renders as — a cited file appeared or vanished. */
export const refreshPreview = StateEffect.define<null>();

const AUDIO = new Set(["mp3", "ogg", "oga", "wav", "flac", "m4a", "weba", "opus", "aac"]);
const VIDEO = new Set(["mp4", "webm", "mkv", "mov", "ogv", "m4v"]);

export function mediaKind(href: string): "image" | "audio" | "video" | "file" {
  const clean = href.split(/[?#]/)[0].toLowerCase();
  const ext = clean.includes(".") ? clean.slice(clean.lastIndexOf(".") + 1) : "";
  if (AUDIO.has(ext)) return "audio";
  if (VIDEO.has(ext)) return "video";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) return "image";
  return "file";
}

// --- Widgets --------------------------------------------------------------

class HrWidget extends WidgetType {
  toDOM() { const el = document.createElement("span"); el.className = "cm-lp-hr"; return el; }
  eq() { return true; }
  ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
  constructor(readonly level: number) { super(); }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lp-bullet";
    el.textContent = this.level % 2 === 0 ? "•" : "◦";
    return el;
  }
  eq(other: BulletWidget) { return other.level === this.level; }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) { super(); }
  toDOM(view: EditorView) {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.className = "cm-lp-task";
    el.checked = this.checked;
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      // The marker is `[ ]` or `[x]`; the byte between the brackets is the one that changes.
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    });
    return el;
  }
  eq(other: TaskWidget) { return other.checked === this.checked && other.pos === this.pos; }
  ignoreEvent() { return true; }
}

class MediaWidget extends WidgetType {
  constructor(
    readonly href: string,
    readonly alt: string,
    readonly url: string | null,
    /** The placeholder's tooltip when the file is missing (AST-12). */
    readonly tip = "",
    /** The target is not media and is known to be missing; media finds out by loading. */
    readonly missing = false,
  ) { super(); }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-media";
    const url = this.url;
    const kind = mediaKind(this.href);
    // Media arrives after the line was measured: without this the heights the
    // viewport is computed from stay wrong and the images further down the
    // document are never decorated, which is what a narrow split pane shows.
    const measured = () => view.requestMeasure();
    const broken = () => {
      measured();
      wrap.replaceChildren();
      const ph = document.createElement("span");
      ph.className = "cm-lp-broken";
      ph.textContent = `Missing asset: ${this.href}`;
      if (this.tip) ph.title = this.tip;
      wrap.appendChild(ph);
    };
    if (!url || this.missing) { broken(); return wrap; }
    if (kind === "image") {
      const img = document.createElement("img");
      img.src = url;
      img.alt = this.alt;
      img.title = this.href;
      img.onload = measured;
      img.onerror = broken;
      wrap.appendChild(img);
    } else if (kind === "audio" || kind === "video") {
      const media = document.createElement(kind);
      media.src = url;
      media.controls = true;
      media.preload = "metadata";
      media.title = this.href;
      media.onloadedmetadata = measured;
      media.onerror = broken;
      if (kind === "audio") {
        const label = document.createElement("span");
        label.className = "cm-lp-media-label";
        label.textContent = this.alt || this.href.split("/").pop() || this.href;
        wrap.appendChild(label);
      }
      wrap.appendChild(media);
    } else {
      const a = document.createElement("span");
      a.className = "cm-lp-link";
      a.textContent = this.alt || this.href;
      a.dataset.href = this.href;
      wrap.appendChild(a);
    }
    return wrap;
  }
  eq(other: MediaWidget) {
    return other.href === this.href && other.alt === this.alt && other.url === this.url && other.tip === this.tip && other.missing === this.missing;
  }
  ignoreEvent(e: Event) { return e.type !== "mousedown" && e.type !== "click"; }
}

/** Whether a cited file is missing: known, or not yet (undefined) until a batched answer arrives. */
function citationMissing(ctx: PreviewContext, path: string): boolean | undefined {
  const e = ctx.citation.exists(path.replace(/\/$/, ""));
  return e === undefined ? undefined : !e;
}

/** Whether an image's target is known to be missing. Only a target that is not media asks; media finds out by loading. */
function imageMissing(ctx: PreviewContext, href: string, target: Resolved): boolean {
  return mediaKind(href) === "file" && ctx.exists(target) === false;
}

/**
 * Whether a line holds nothing but citations and whitespace, where cited media
 * is drawn as the media (CITE-18). A quote mark or list marker opening the
 * line is block markup, not text beside the citation, so `- @a.png` and
 * `> @a.png` count; anything else on the line — a word, a heading mark, a
 * `<br>`, a task box — does not.
 */
function citationsOnly(state: EditorState, tree: Tree, line: Line): boolean {
  let pos = line.from;
  let only = true;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(n) {
      if (!only) return false;
      if (n.name !== "Citation" && n.name !== "QuoteMark" && n.name !== "ListMark") return true;
      if (state.doc.sliceString(pos, Math.max(pos, n.from)).trim()) only = false;
      pos = Math.max(pos, n.to);
      return false;
    },
  });
  return only && !state.doc.sliceString(pos, line.to).trim();
}

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "|") { cells.push(cur); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** Each column's alignment class, from a table's delimiter row (`:---:`, `---:`). */
function alignments(state: EditorState, table: SyntaxNode): string[] {
  const d = table.getChild("TableDelimiter");
  return d ? splitRow(state.doc.sliceString(d.from, d.to)).map((c) => (c.startsWith(":") && c.endsWith(":") ? " cm-lp-align-center" : c.endsWith(":") ? " cm-lp-align-right" : "")) : [];
}

/**
 * A `<br>` in a table cell: a line break inside the cell (ED-49). The widget
 * is a box-less wrapper around the `<br>`, so the editor's hit-testing never
 * lands on it: a `<br>` has a box at the end of the line it ends, and a click
 * or a vertical move past that line's end took the position after it, which
 * is on the next line.
 */
class BreakWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lp-br";
    el.appendChild(document.createElement("br"));
    return el;
  }
  eq() { return true; }
  // A caret stands at the editor's spacer on its side of the break: before
  // it at the end of the line it ends, after it where the next line starts.
  coordsAt(dom: HTMLElement, pos: number) {
    const spacer = pos > 0 ? dom.nextElementSibling : dom.previousElementSibling;
    return spacer ? spacer.getBoundingClientRect() : null;
  }
}

/**
 * A table cell with nothing at all between its pipes (`||`), which has no
 * text to mark as a cell: it is drawn as an empty cell, held at its column's
 * width, and a click on it puts the caret between the pipes.
 */
class EmptyCellWidget extends WidgetType {
  constructor(readonly cls: string, readonly style: string) { super(); }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = this.cls;
    if (this.style) el.setAttribute("style", this.style);
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      view.focus();
      view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(el), -1), userEvent: "select.pointer" });
    });
    return el;
  }
  eq(other: EmptyCellWidget) { return other.cls === this.cls && other.style === this.style; }
  // The caret stands at the start of the cell's content, one line tall, in the middle of the row.
  coordsAt(dom: HTMLElement) {
    const box = dom.getBoundingClientRect();
    const style = getComputedStyle(dom);
    const x = box.left + parseFloat(style.paddingLeft);
    const y = (box.top + box.bottom) / 2;
    const half = parseFloat(style.fontSize) * 0.6;
    return { left: x, right: x, top: y - half, bottom: y + half };
  }
}

interface FrontmatterRow { key: string; value: string; valueFrom: number; valueTo: number; editable: boolean }

function frontmatterRows(state: EditorState, from: number, to: number): FrontmatterRow[] {
  const rows: FrontmatterRow[] = [];
  const first = state.doc.lineAt(from).number + 1;
  const last = state.doc.lineAt(to).number - 1;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    const m = /^([A-Za-z0-9_.-]+):(\s?)(.*)$/.exec(line.text);
    if (m && !line.text.startsWith(" ")) {
      const prefix = m[1].length + 1 + m[2].length;
      const value = m[3];
      const editable = value.trim() !== "" && !/^[>|]/.test(value.trim());
      rows.push({ key: m[1], value, valueFrom: line.from + prefix, valueTo: line.to, editable });
    } else if (rows.length && line.text.trim()) {
      const prev = rows[rows.length - 1];
      prev.value = prev.value ? `${prev.value}\n${line.text}` : line.text;
      prev.editable = false;
    }
  }
  return rows;
}

class FrontmatterWidget extends WidgetType {
  constructor(readonly text: string, readonly rows: FrontmatterRow[]) { super(); }
  toDOM(view: EditorView) {
    // The box's spacing is padding on a wrapper: the editor's height map does
    // not count a block widget's margins (FIX-20).
    const box = document.createElement("div");
    box.className = "cm-lp-frontmatter-wrap";
    const table = box.appendChild(document.createElement("table"));
    table.className = "cm-lp-frontmatter";
    for (const row of this.rows) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = row.key;
      const td = document.createElement("td");
      if (row.editable) {
        const input = document.createElement("input");
        input.value = row.value;
        input.spellcheck = false;
        const commit = () => {
          if (input.value === row.value) return;
          view.dispatch({ changes: { from: row.valueFrom, to: row.valueTo, insert: input.value } });
        };
        input.addEventListener("change", commit);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { commit(); input.blur(); } });
        td.appendChild(input);
      } else {
        const pre = document.createElement("pre");
        pre.textContent = row.value || "(edit in source)";
        td.appendChild(pre);
      }
      tr.append(th, td);
      table.appendChild(tr);
    }
    if (this.rows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.textContent = "(empty frontmatter)";
      tr.appendChild(td);
      table.appendChild(tr);
    }
    return box;
  }
  eq(other: FrontmatterWidget) { return other.text === this.text; }
  ignoreEvent() { return true; }
}

/**
 * A code block's opening fence, drawn as the top of its box with the language
 * as a label the user can change (RICH-13). A change writes the info string's
 * bytes and nothing else.
 */
class CodeHeadWidget extends WidgetType {
  constructor(readonly info: string) { super(); }
  toDOM(view: EditorView) {
    const head = document.createElement("div");
    head.className = "cm-lp-code-head";
    const bar = head.appendChild(document.createElement("div"));
    bar.className = "cm-lp-code-bar";
    const input = bar.appendChild(document.createElement("input"));
    input.className = "cm-lp-code-lang";
    input.value = this.info;
    input.placeholder = "plain text";
    input.title = "The code block's language";
    input.spellcheck = false;
    const commit = () => {
      const range = infoRange(view.state, view.posAtDOM(head));
      if (!range) return;
      // An info string is one line, and a backtick fence's cannot hold a backtick.
      let value = input.value.replace(/[\r\n]/g, "").trim();
      if (range.fence.startsWith("`")) value = value.replace(/`/g, "");
      if (value !== view.state.doc.sliceString(range.from, range.to)) {
        view.dispatch({ changes: { from: range.from, to: range.to, insert: value }, userEvent: "input" });
      }
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") input.value = this.info;
      else return;
      e.preventDefault();
      view.focus();
    });
    return head;
  }
  eq(other: CodeHeadWidget) { return other.info === this.info; }
  ignoreEvent() { return true; }
}

/** A code block's closing fence, drawn as the bottom of its box. */
class CodeFootWidget extends WidgetType {
  toDOM() {
    const foot = document.createElement("div");
    foot.className = "cm-lp-code-foot";
    return foot;
  }
  eq() { return true; }
}

// --- Block-level drawing: a state field, because replacing whole lines and
// hiding line breaks changes the vertical layout outside the viewport.

/** What the field holds: `rich.ts`'s layout, as decorations, atomic ranges and the boxes that hold tables. */
interface Drawn {
  exempt: number[];
  layout: Layout;
  decorations: DecorationSet;
  atomic: RangeSet<Decoration>;
  wrappers: RangeSet<BlockWrapper>;
}

/**
 * A table's box. Its rows are CodeMirror's own lines, drawn as table rows
 * whose cells are marks over each cell's text, so the browser lays out one
 * table from them and every cell is edited as text (RICH-11).
 */
const TABLE_BOX = BlockWrapper.create({ tagName: "div", attributes: { class: "cm-lp-table-wrap" } });

const ATOM = Decoration.mark({});

/**
 * Ranges the caret never enters, with those that touch joined: the caret
 * stops at neither side of a join. The pipe between two table cells joins
 * nothing, since the caret stops on both sides of it.
 */
function atoms(ranges: { from: number; to: number; cell?: boolean }[]): RangeSet<Decoration> {
  const merged: { from: number; to: number; cell?: boolean }[] = [];
  for (const r of ranges.filter((r) => r.to > r.from).sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to && !r.cell && !last.cell) last.to = Math.max(last.to, r.to);
    else merged.push({ from: r.from, to: r.to, cell: r.cell });
  }
  return Decoration.set(merged.map((r) => ATOM.range(r.from, r.to)));
}

function blockWidget(state: EditorState, b: Block): WidgetType {
  const { node } = b;
  if (b.kind === "fence-open") {
    const info = node.getChild("CodeInfo");
    return new CodeHeadWidget(info ? state.doc.sliceString(info.from, info.to) : "");
  }
  if (b.kind === "fence-close") return new CodeFootWidget();
  const from = state.doc.lineAt(node.from).from;
  const to = state.doc.lineAt(Math.max(node.from, node.to - 1)).to;
  return new FrontmatterWidget(state.doc.sliceString(from, to), frontmatterRows(state, from, to));
}

function draw(state: EditorState, exempt: number[]): Drawn {
  const lay = layout(state, exempt);
  const ranges: Range<Decoration>[] = [];
  const atomic: { from: number; to: number }[] = [];
  for (const b of lay.blocks) {
    ranges.push(Decoration.replace({ widget: blockWidget(state, b), block: true }).range(b.from, b.to));
    // With the line breaks either side, so the caret passes over the widget in one step.
    atomic.push({ from: Math.max(0, b.from - 1), to: Math.min(state.doc.length, b.to + 1) });
  }
  for (const m of lay.merges) {
    ranges.push(Decoration.replace({}).range(m.from, m.to));
    atomic.push(m);
  }
  for (const g of lay.gaps) ranges.push(Decoration.line({ class: "cm-lp-gap" }).range(g));
  const wrappers = BlockWrapper.set(lay.tables.map((t) => TABLE_BOX.range(t.from, t.to)));
  return { exempt, layout: lay, decorations: Decoration.set(ranges, true), atomic: atoms(atomic), wrappers };
}

/** Block decorations come from a state field: they change the vertical layout outside the viewport too. */
const blockField = StateField.define<Drawn>({
  create: (state) => draw(state, exemptLines(state)),
  update(value, tr) {
    const exempt = exemptLines(tr.state);
    const held = exempt.join() === value.exempt.join();
    if (tr.docChanged) {
      // An edit inside one block's text leaves the drawing where it was, moved.
      if (held && layoutHolds(tr, value.layout)) {
        return {
          exempt,
          layout: mapLayout(value.layout, tr.changes),
          decorations: value.decorations.map(tr.changes),
          atomic: value.atomic.map(tr.changes),
          wrappers: value.wrappers.map(tr.changes),
        };
      }
      return draw(tr.state, exempt);
    }
    return held && syntaxTree(tr.state) === syntaxTree(tr.startState) ? value : draw(tr.state, exempt);
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
    EditorView.blockWrappers.from(f, (v) => v.wrappers),
  ],
});

// --- Inline decorations: a view plugin over the visible ranges.

/** Constructs the renderer does not draw: each shows its source in a box of its own (RICH-15). */
const RAW = new Set(["HTMLBlock", "CommentBlock", "ProcessingInstructionBlock", "LinkReference"]);

const BREAK = new BreakWidget();

/** An object's widget: a rule, a line break in a table cell, an image, or a citation — media on a line of its own, a chip anywhere else (CITE-18, CITE-07). */
function objectWidget(state: EditorState, ctx: PreviewContext, o: Obj, alone: (pos: number) => boolean): WidgetType {
  const text = state.doc.sliceString(o.from, o.to);
  if (o.name === "HorizontalRule") return new HrWidget();
  if (o.name === "HTMLTag") return BREAK;
  const image = o.name === "Image" ? IMAGE.exec(text) : null;
  if (image) {
    const target = ctx.resolve(image[2], true);
    return new MediaWidget(image[2], image[1], target.url, target.tip, imageMissing(ctx, image[2], target));
  }
  const path = citedPath(text);
  if (mediaKind(path) !== "file" && alone(o.from)) {
    const target = ctx.resolve(path, false);
    return new MediaWidget(path, path.split("/").pop() ?? path, target.url, target.tip);
  }
  return new ChipWidget(path, citationMissing(ctx, path), ctx.citation);
}

interface Inline {
  decorations: DecorationSet;
  atomic: RangeSet<Decoration>;
  /** A table cell's mark over each cell's text, outside every other mark so none splits a cell in two. */
  cells: DecorationSet;
}

/**
 * The inline drawing of `ranges`, the view's visible ranges or a table's
 * lines. `widths` gives the widths a table's columns are held at, if any.
 */
function inlineDecorations(
  view: EditorView, ctx: PreviewContext, lay: Layout, ranges: readonly { from: number; to: number }[], widths: (table: SyntaxNode) => number[] | undefined,
): Inline {
  const { state } = view;
  const tree = syntaxTree(state);
  const marks: Range<Decoration>[] = [];
  const lines: Range<Decoration>[] = [];
  const cells: Range<Decoration>[] = [];
  const atomic: { from: number; to: number }[] = [];
  /** Each table's column alignments and widths, worked out once per table however many of its rows are drawn. */
  const tables = new Map<number, { align: string[]; widths?: number[] }>();
  const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>) => {
    if (to > from) marks.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to));
  };
  const lineClass = (from: number, to: number, cls: string) => {
    const a = state.doc.lineAt(from).number;
    const b = state.doc.lineAt(Math.max(from, to - 1)).number;
    for (let n = a; n <= b; n++) lines.push(Decoration.line({ class: cls }).range(state.doc.line(n).from));
  };
  /** A source box: every line in the box's colour, with its first and last lines closing it. */
  const rawBox = (from: number, to: number) => {
    const a = state.doc.lineAt(from).number;
    const b = state.doc.lineAt(Math.max(from, to - 1)).number;
    for (let n = a; n <= b; n++) {
      const cls = `cm-lp-raw${n === a ? " cm-lp-raw-first" : ""}${n === b ? " cm-lp-raw-last" : ""}`;
      lines.push(Decoration.line({ class: cls }).range(state.doc.line(n).from));
    }
  };
  const selected = (o: Obj) => state.selection.ranges.some((r) => !r.empty && r.from <= o.from && r.to >= o.to);
  /** `citationsOnly` for the line at `pos`, worked out once per line however many citations it holds. */
  const own = new Map<number, boolean>();
  const alone = (pos: number) => {
    const line = state.doc.lineAt(pos);
    let only = own.get(line.from);
    if (only === undefined) own.set(line.from, (only = citationsOnly(state, tree, line)));
    return only;
  };

  const done = new Set<number>();
  for (const { from, to } of ranges) {
    // What `rich.ts` hides and which objects it draws, line by line.
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (done.has(line.number)) continue;
      done.add(line.number);
      const syntax = lineSyntax(state, line, lay);
      const { objects, row } = syntax;
      let { pieces } = syntax;
      if (row) {
        // A row is a table row; each cell's text is a table cell, and the pipes
        // between them are hidden pieces outside every cell (RICH-11, ED-50).
        // Spaces just typed at the end of a cell are drawn in it up to the caret.
        lines.push(Decoration.line({ class: row.head ? "cm-lp-tr cm-lp-thead" : "cm-lp-tr cm-lp-tbody" }).range(line.from));
        const node = row.node.parent!;
        let table = tables.get(node.from);
        if (!table) tables.set(node.from, (table = { align: alignments(state, node), widths: widths(node) }));
        const { main } = state.selection;
        const tail = main.empty && main.head >= line.from && main.head <= line.to ? cellTail(state, row, main.head) : null;
        if (tail) pieces = pieces.map((p) => (p.from === tail.from ? { ...p, from: main.head } : p)).filter((p) => p.to > p.from);
        row.cells.forEach((c, j) => {
          const cls = `cm-lp-td${table.align[j] ?? ""}`;
          const w = table.widths?.[j];
          const style = w === undefined ? "" : `min-width: ${w}px; max-width: ${w}px`;
          const to = tail?.column === j ? main.head : c.to;
          // Inclusive, so a chip or an image at either end of the text is drawn inside the cell.
          if (to > c.from) cells.push(Decoration.mark({ class: cls, inclusive: true, attributes: style ? { style } : undefined }).range(c.from, to));
          else marks.push(Decoration.widget({ widget: new EmptyCellWidget(cls, style), side: -1 }).range(c.from));
        });
      }
      for (const p of pieces) {
        if (p.draw === "hide") marks.push(Decoration.replace({}).range(p.from, p.to));
        else if (p.draw === "bullet") marks.push(Decoration.replace({ widget: new BulletWidget(p.level ?? 0) }).range(p.from, p.mark ?? p.to));
        else if (p.draw === "task") marks.push(Decoration.replace({ widget: new TaskWidget(!!p.checked, p.from) }).range(p.from, p.mark ?? p.to));
        atomic.push(p);
      }
      for (const o of objects) {
        // A citation in a table cell is a chip, never the media (CITE-18).
        marks.push(Decoration.replace({ widget: objectWidget(state, ctx, o, row ? () => false : alone) }).range(o.from, o.to));
        // A selected image wears an outline (RICH-14).
        if (selected(o)) mark(o.from, o.to, "cm-lp-selected");
        atomic.push(o);
      }
    }
    // How the rest is styled.
    tree.iterate({
      from, to,
      enter(n) {
        const name = n.name;
        if (name === "Frontmatter") return false;
        if (/^ATXHeading[1-6]$/.test(name)) {
          lineClass(n.from, n.to, `cm-lp-h${name.slice(-1)}`);
          return true;
        }
        if (name === "SetextHeading1" || name === "SetextHeading2") {
          lineClass(n.from, state.doc.lineAt(n.from).to, `cm-lp-h${name.slice(-1)}`);
          return true;
        }
        if (RAW.has(name) || isFootnote(state, n)) {
          rawBox(n.from, n.to);
          return false;
        }
        switch (name) {
          case "Emphasis": mark(n.from, n.to, "cm-lp-em"); return true;
          case "StrongEmphasis": mark(n.from, n.to, "cm-lp-strong"); return true;
          case "Strikethrough": mark(n.from, n.to, "cm-lp-strike"); return true;
          case "InlineCode": mark(n.from, n.to, "cm-lp-code"); return false;
          case "FencedCode":
          case "CodeBlock": lineClass(n.from, n.to, "cm-lp-codeline"); return false;
          case "HTMLTag":
          case "Comment": mark(n.from, n.to, "cm-lp-html"); return false;
          case "Blockquote": lineClass(n.from, n.to, "cm-lp-quote"); return true;
          case "ListMark":
            if (n.node.parent?.parent?.name === "OrderedList") mark(n.from, n.to, "cm-lp-listmark");
            return false;
          case "Image": {
            // An image whose alt text runs onto another line is no object: a
            // plugin may not replace a line break, so it is drawn after its source.
            const m = IMAGE.exec(state.doc.sliceString(n.from, n.to));
            if (m && state.doc.lineAt(n.from).number !== state.doc.lineAt(n.to).number) {
              const target = ctx.resolve(m[2], true);
              marks.push(Decoration.widget({ widget: new MediaWidget(m[2], m[1], target.url, target.tip, imageMissing(ctx, m[2], target)), side: 1 }).range(n.to));
            }
            return true;
          }
          case "Link": {
            const marksOf = n.node.getChildren("LinkMark");
            const url = n.node.getChild("URL");
            if (marksOf.length < 2 || (!url && !n.node.getChild("LinkLabel"))) return true;
            const href = url ? state.doc.sliceString(url.from, url.to) : "";
            mark(marksOf[0].to, marksOf[1].from, "cm-lp-link", { "data-href": href, title: href });
            return true;
          }
          case "Autolink": {
            const url = n.node.getChild("URL");
            if (url) mark(url.from, url.to, "cm-lp-link", { "data-href": state.doc.sliceString(url.from, url.to) });
            return false;
          }
          case "URL":
            // A bare web address; one inside a link or an image is that construct's target.
            if (!/^(Link|Image|Autolink|LinkReference)$/.test(n.node.parent?.name ?? "")) mark(n.from, n.to, "cm-lp-link", { "data-href": state.doc.sliceString(n.from, n.to) });
            return false;
        }
        return true;
      },
    });
  }
  return { decorations: Decoration.set([...marks, ...lines], true), atomic: atoms(atomic), cells: Decoration.set(cells, true) };
}

/**
 * What CodeMirror draws: the visible ranges, and the lines holding the main
 * selection's ends, which it draws wherever they are. Left undecorated, a
 * heading holding the caret would lose its size each time it left the
 * viewport, and the text below it would move.
 */
function drawnRanges(view: EditorView): { from: number; to: number }[] {
  const ranges = [...view.visibleRanges];
  const { main } = view.state.selection;
  for (const pos of new Set([main.anchor, main.head])) {
    if (pos >= view.viewport.from && pos <= view.viewport.to) continue;
    const { from, to } = view.lineBlockAt(pos);
    if (!ranges.some((r) => r.from <= to && from <= r.to)) ranges.push({ from, to });
  }
  return ranges.sort((a, b) => a.from - b.from);
}

// --- Table columns: sized from every row, not only the drawn ones.

/** Draws the tables' columns again: one was measured anew, or the box they share out changed width. */
const redrawColumns = StateEffect.define<null>();

/** How long edits to a table, or news of what it draws, settle before its columns are measured again. */
const SETTLE_MS = 400;

/**
 * A table's columns over all its rows: each one's narrowest and widest layout
 * in px, padding included, and what its rows draw beside the cells — a
 * quote's bar.
 */
interface Measured { from: number; to: number; min: number[]; max: number[]; beside: number; stale: boolean }

/**
 * The widths columns take in a box `box` px wide, as CSS's automatic table
 * layout shares it out: the widest layout of each when they all fit, the
 * narrowest when even those do not (and the table's box scrolls, ED-51), and
 * otherwise each column's narrowest plus a share of the room left in
 * proportion to how much wider it could be.
 */
function share(min: number[], max: number[], box: number): number[] {
  const sum = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  const low = sum(min);
  const high = sum(max);
  if (high <= box) return max;
  if (low >= box) return min;
  return min.map((w, j) => w + Math.floor(((box - low) * (max[j] - w)) / (high - low)));
}

/** The width of an element's content box, which a table's box fills. */
function contentWidth(el: HTMLElement): number {
  const s = getComputedStyle(el);
  return Math.floor(el.getBoundingClientRect().width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight));
}

/** What a measure depends on besides the text: the prose font and size, and the code font. */
function fontOf(el: HTMLElement): string {
  const s = getComputedStyle(el);
  return `${s.fontFamily} ${s.fontSize} ${s.getPropertyValue("--mono")}`;
}

/** `node`, inside a span carrying the classes of the marks over it, as CodeMirror would draw it. */
function marked(node: Node, active: readonly Decoration[]): Node {
  const cls = active.map((d) => d.spec.class).filter(Boolean).join(" ");
  if (!cls) return node;
  const span = document.createElement("span");
  span.className = cls;
  span.append(node);
  return span;
}

/**
 * The widths every table's columns are held at (ED-48, ED-50). CodeMirror
 * draws only the rows near the viewport, and the browser sizes a table's
 * columns from the rows it is given, so left to itself a column widens and
 * narrows as rows scroll in and out, and the rows below it wrap anew. A
 * table's cells are instead laid out once, all of its rows, off screen in the
 * page's own styles, which gives each column's narrowest and widest layout;
 * every drawn cell is then held at its column's width (`share`) with an equal
 * `min-width` and `max-width`, which WebKitGTK honours on a table cell. A
 * table is measured when it is first drawn; again when edits to it, an image
 * loading in it or a cited file's news settle, keeping its widths meanwhile;
 * and whenever the fonts change. A change of the box's width only shares the
 * room out again.
 */
class TableColumns {
  /** Each measured table, by where its syntax node starts. */
  private tables = new Map<number, Measured>();
  /** The width a table's box has: the content's. */
  private box = 0;
  /** The content's width as last observed; 0 while the view is hidden. */
  private shown = 0;
  private font = "";
  /** Images a measure has waited for, so one that never reports itself loaded measures once more, not forever. */
  private readonly loading = new Set<string>();
  private timer = 0;
  private frame = 0;
  private readonly resize: ResizeObserver;

  constructor(private readonly view: EditorView, private readonly ctx: PreviewContext) {
    this.resize = new ResizeObserver((entries) => this.resized(entries[entries.length - 1].contentRect.width));
    this.resize.observe(view.contentDOM);
  }

  /** The widths `table`'s columns are drawn at, measuring it first when it has no measure; none while the view has no layout. */
  widths(table: SyntaxNode, lay: Layout): number[] | undefined {
    let m = this.tables.get(table.from);
    // A table that grew or shrank with no edit to it was cut short by a parse still under way.
    if (!m || (m.to !== table.to && !m.stale)) m = this.measure(table, lay);
    return m && share(m.min, m.max, this.box - m.beside);
  }

  /** An edit moves every measure with its table; one the edit touched is kept until the edits settle. */
  map(changes: ChangeDesc): void {
    const moved = new Map<number, Measured>();
    let touched = false;
    for (const m of this.tables.values()) {
      if (changes.touchesRange(m.from, m.to)) m.stale = touched = true;
      m.from = changes.mapPos(m.from, -1);
      m.to = changes.mapPos(m.to, 1);
      moved.set(m.from, m);
    }
    this.tables = moved;
    if (touched) this.settle();
  }

  /** A cited file appeared or vanished, which changes what its chip draws. */
  refresh(): void {
    for (const m of this.tables.values()) m.stale = true;
    if (this.tables.size) this.settle();
  }

  destroy(): void {
    this.resize.disconnect();
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
  }

  /** Measures the stale tables again once things settle: each as it is next drawn. */
  private settle(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      for (const [from, m] of this.tables) if (m.stale) this.tables.delete(from);
      this.view.dispatch({ effects: redrawColumns.of(null) });
    }, SETTLE_MS);
  }

  /**
   * The content changed size. A new width shares every table's room out
   * again, new fonts measure every table again, and a view shown again draws
   * the tables it could not measure while hidden. The redraw waits a frame:
   * a view updated inside a resize observer resizes what it observes.
   */
  private resized(width: number): void {
    const box = Math.floor(width);
    const font = fontOf(this.view.contentDOM);
    if (box === this.shown && font === this.font) return;
    this.shown = box;
    if (!box) return;
    if (font !== this.font) this.tables.clear();
    this.box = box;
    this.font = font;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.view.dispatch({ effects: redrawColumns.of(null) }));
  }

  /**
   * Lays every row of `table` out off screen, each column once as narrow and
   * once as wide as its cells allow, with the classes CodeMirror would draw
   * them with: the rendered view's marks and widgets, and the syntax
   * highlighting's. None when the view is not laid out.
   */
  private measure(table: SyntaxNode, lay: Layout): Measured | undefined {
    const { view } = this;
    if (!this.box) {
      this.box = contentWidth(view.contentDOM);
      this.font = fontOf(view.contentDOM);
      if (!this.box) return undefined;
    }
    const { state } = view;
    const { doc } = state;
    const first = doc.lineAt(table.from);
    const last = doc.lineAt(Math.max(table.from, table.to - 1));
    const { decorations } = inlineDecorations(view, this.ctx, lay, [{ from: first.from, to: last.to }], () => undefined);
    const highlights: Range<Decoration>[] = [];
    highlightTree(syntaxTree(state), { style: (tags) => highlightingFor(state, tags) }, (from, to, cls) => highlights.push(Decoration.mark({ class: cls }).range(from, to)), first.from, last.to);
    const sets = [Decoration.set(highlights, true), decorations];
    const columns: HTMLElement[] = [];
    for (let n = first.number; n <= last.number; n++) {
      const row = tableRow(state, doc.line(n).from);
      row?.cells.forEach((c, j) => {
        const cell = document.createElement("span");
        cell.className = "cm-lp-td";
        RangeSet.spans(sets, c.from, c.to, {
          span: (from, to, active) => cell.append(marked(document.createTextNode(doc.sliceString(from, to)), active)),
          point: (_from, _to, deco, active) => {
            const widget = deco.spec.widget as WidgetType | undefined;
            if (widget && !(widget instanceof EmptyCellWidget)) cell.append(marked(widget.toDOM(view), active));
          },
        });
        const column = (columns[j] ??= document.createElement("div"));
        // A header cell sits in a header row, which draws it bold.
        if (row.head) {
          const head = column.appendChild(document.createElement("div"));
          head.className = "cm-lp-thead";
          head.appendChild(cell);
        } else {
          column.appendChild(cell);
        }
      });
    }
    const offscreen = document.createElement("div");
    offscreen.className = "cm-lp-measure";
    for (const narrow of columns) {
      const wide = narrow.cloneNode(true) as HTMLElement;
      narrow.style.width = "min-content";
      wide.style.width = "max-content";
      offscreen.append(narrow, wide);
    }
    // A quoted table's rows draw the quote's bar as their border, which the table adds to its cells' widths.
    let quoted = false;
    for (let n = table.parent; n; n = n.parent) if (n.name === "Blockquote") quoted = true;
    const quote = quoted ? offscreen.appendChild(document.createElement("div")) : null;
    if (quote) quote.className = "cm-line cm-lp-quote";
    view.dom.appendChild(offscreen);
    const px = (el: Element) => Math.ceil(el.getBoundingClientRect().width);
    const min = columns.map(px);
    const max = columns.map((c, j) => Math.max(min[j], px(c.nextElementSibling!)));
    const beside = quote ? Math.ceil(parseFloat(getComputedStyle(quote).borderLeftWidth)) : 0;
    const m: Measured = { from: table.from, to: table.to, min, max, beside, stale: false };
    // An image sizes its column once it has loaded; each one is waited for once.
    for (const img of offscreen.querySelectorAll("img")) {
      if (img.complete || this.loading.has(img.src)) continue;
      this.loading.add(img.src);
      img.addEventListener("load", () => { m.stale = true; this.settle(); }, { once: true });
    }
    offscreen.remove();
    // A hidden view lays nothing out; a cell is at least its padding wide.
    if (!min[0]) return undefined;
    this.tables.set(m.from, m);
    return m;
  }
}

// --- Editing: the keys, typed text and selections of the rendered view.

/** A transaction whose changes `rich.ts` already made byte-exact, which the filter below leaves alone. */
const spliced = Annotation.define<boolean>();

/**
 * The rendered view's keys (ADR-011): the arrows move by visible character
 * and Ctrl+arrows by word over hidden syntax (RICH-02); Backspace and Delete
 * take visible text and objects and never leave empty marks behind (RICH-02,
 * RICH-14); Enter and Shift+Enter make paragraphs and hard breaks (RICH-19).
 * Enter sits below the Markdown keymap, which continues lists and quotes
 * first (TYP-13 to TYP-16). Backspace and Delete sit above it, whose Backspace
 * takes only hidden marks, and below RICH-07's Backspace at a block's start
 * (`format.ts`), which is installed first; a bracket pair just typed still
 * goes as one. Each key is one transaction, so one undo (RICH-18).
 */
function richKeymap(field: StateField<Drawn>): Extension {
  const lay = (state: EditorState) => state.field(field).layout;
  const move = (forward: boolean, extend: boolean, word: boolean): Command => (view) => {
    const { state } = view;
    const l = lay(state);
    const ranges = state.selection.ranges.map((r) => (word ? moveGroup : moveChar)(state, l, r, forward, extend));
    const selection = EditorSelection.create(ranges, state.selection.mainIndex);
    if (!selection.eq(state.selection)) view.dispatch({ selection, scrollIntoView: true, userEvent: "select" });
    return true;
  };
  // A key that finds nothing to delete still ends there: the editor's own
  // deletion would take a hidden mark or a whole widget. The caret lands
  // where typing continues the text before it.
  const remove = (forward: boolean, word: boolean): Command => (view) => {
    const { state } = view;
    const l = lay(state);
    const spec = state.changeByRange((range) => deleteBy(state, l, range, forward, word) ?? { range });
    if (spec.changes.empty) return true;
    const extra = { scrollIntoView: true, userEvent: forward ? "delete.forward" : "delete.backward", annotations: spliced.of(true) };
    const tr = state.update(spec, extra);
    const next = tr.state;
    const settled = next.selection.ranges.map((r) => (r.empty ? canonical(next, lay(next), r.head, forward ? 1 : -1) : r));
    view.dispatch(settled.every((r, i) => r.head === next.selection.ranges[i].head) ? tr
      : state.update({ changes: spec.changes, selection: EditorSelection.create(settled, next.selection.mainIndex) }, extra));
    return true;
  };
  const lineBreak = (hard: boolean): Command => (view) => {
    const { state } = view;
    if (state.selection.ranges.length > 1) return false;
    // A selection goes first, and the break lands where it was: one change, one undo.
    let base = state;
    let before: ChangeSet | null = null;
    if (!state.selection.main.empty) {
      const { from, to } = state.selection.main;
      before = mended(state, deletion(state, from, to));
      base = state.update({ changes: before, selection: EditorSelection.cursor(before.mapPos(from, -1)) }).state;
    }
    const range = base.selection.main;
    let edit = (hard ? hardBreak : enter)(base, lay(base), range);
    if (!edit) {
      if (!before) return false;
      edit = { changes: { from: range.head, insert: "\n" }, range: EditorSelection.cursor(range.head + 1) };
    }
    const after = base.changes(edit.changes);
    if (after.empty && !before) return true;
    view.dispatch(state.update({
      changes: before ? before.compose(after) : after,
      selection: edit.range,
      scrollIntoView: true,
      userEvent: "input",
      // A new paragraph starts a new undo step, as Enter does in the source view.
      annotations: [spliced.of(true), isolateHistory.of("before")],
    }));
    return true;
  };
  const back: Command = (view) => deleteBracketPair(view) || remove(false, false)(view);
  return [
    Prec.highest(keymap.of([
      { key: "Backspace", run: back, shift: back },
      { key: "Delete", run: remove(true, false), shift: remove(true, false) },
      { key: "Mod-Backspace", run: remove(false, true) },
      { key: "Mod-Delete", run: remove(true, true) },
    ])),
    Prec.high(keymap.of([
      { key: "ArrowLeft", run: move(false, false, false), shift: move(false, true, false) },
      { key: "ArrowRight", run: move(true, false, false), shift: move(true, true, false) },
      { key: "Mod-ArrowLeft", run: move(false, false, true), shift: move(false, true, true) },
      { key: "Mod-ArrowRight", run: move(true, false, true), shift: move(true, true, true) },
      { key: "Enter", run: lineBreak(false) },
      { key: "Shift-Enter", run: lineBreak(true) },
    ])),
  ];
}

/**
 * Typed text goes where the caret stands in the document, whichever side of a
 * hidden mark, or of the hidden pipe between two table cells, the page put its
 * own caret (RICH-03). Text typed on an empty line under a list item or a
 * quote is given a blank line first, so it starts a paragraph rather than
 * joining the item above.
 */
function typing(field: StateField<Drawn>): Extension {
  const handler = (view: EditorView, from: number, to: number, text: string): boolean => {
    const { state } = view;
    const { main } = state.selection;
    if (view.composing || state.selection.ranges.length > 1 || !main.empty || from !== to) return false;
    const lay = state.field(field).layout;
    const run = runAt(state, lay, main.head);
    const beside = (forward: boolean) => {
      const u = step(state, lay, main.head, forward);
      return !!u && u.char === "\t" && from >= u.from && from <= u.to;
    };
    if ((from < run.from || from > run.to) && !beside(true) && !beside(false)) return false;
    const at = settle(state, lay, main, 0, true).head;
    const lead = paragraphBreakBefore(state, at) ?? "";
    if (from === at && !lead) return false;
    const insert = () => state.update({
      changes: { from: at, insert: lead + text },
      selection: EditorSelection.cursor(at + lead.length + text.length),
      userEvent: "input.type",
      scrollIntoView: true,
    });
    // The other handlers — pending formatting, bracket pairs — see the corrected place.
    if (!lead && state.facet(EditorView.inputHandler).some((h) => h !== handler && h(view, at, at, text, insert))) return true;
    view.dispatch(insert());
    return true;
  };
  return Prec.highest(EditorView.inputHandler.of(handler));
}

/**
 * Keeps the caret where `rich.ts` says it stands. A caret the pointer, a key
 * or the other view put down is moved to its run's typing position (RICH-03),
 * unless it only moved within the run it was in and typing there is safe:
 * that keeps the caret an edit left after the closing marks of a word just
 * typed as `**word**`, and leaves the page's own caret alone when it settles
 * on the other side of a hidden mark. A selection-only change marked as input
 * keeps its caret. And text typed, pasted, dropped, cut or dragged away keeps
 * the syntax of whatever it only partly covers (RICH-18): what goes is what
 * `deletion` takes, text typed over a selection replaces `typedRange`, text
 * dropped lands where the caret can stand, less the syntax of the constructs
 * it lands inside (`landing`), and text holding a line break is written as
 * `pasted` gives it. The whole is written as `mended` gives it, so no mark is
 * left showing as text; a drop that would leave one lands as plain text.
 */
function caretFilter(field: StateField<Drawn>): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (tr.annotation(spliced)) return tr;
    const start = tr.startState;
    if (!tr.docChanged) {
      if (!tr.selection || tr.isUserEvent("input")) return tr;
      const lay = start.field(field).layout;
      let moved = false;
      const ranges = tr.selection.ranges.map((r, i) => {
        if (!r.empty) return r;
        const prev = start.selection.ranges[i];
        const run = prev?.empty ? runAt(start, lay, prev.head) : null;
        const within = !!run && r.head >= run.from && r.head <= run.to;
        const at = settle(start, lay, r, prev ? Math.sign(r.head - prev.head) : 0, within);
        if (at.head !== r.head) moved = true;
        // A caret moved up or down keeps the column it is heading for.
        return at === r ? at : EditorSelection.cursor(at.head, at.assoc, undefined, r.goalColumn);
      });
      return moved ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }] : tr;
    }
    const drop = tr.isUserEvent("move.drop") || tr.isUserEvent("input.drop");
    if (tr.isUserEvent("input.type.compose") || !(drop || tr.isUserEvent("input.type") || tr.isUserEvent("input.paste") || tr.isUserEvent("delete.cut"))) return tr;
    const changed: { from: number; to: number; text: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { changed.push({ from: fromA, to: toA, text: inserted.toString() }); });
    // Text typed at the caret, the common case, is already where `typing` put it.
    if (!drop && changed.every((c) => c.from === c.to && !c.text.includes("\n"))) return tr;
    const lay = start.field(field).layout;
    const removed: { from: number; to: number; insert?: string }[] = [];
    const typed: { at: number; text: string }[] = [];
    const cuts: number[] = [];
    for (const c of changed) {
      if (c.to > c.from) {
        const range = c.text ? typedRange(start, lay, c.from, c.to) : c;
        const del = range.to > range.from ? deletion(start, range.from, range.to, !!c.text && !c.text.includes("\n")) : [];
        // A word dragged out from between two spaces takes one of them with it.
        const last = del[del.length - 1];
        if (drop && !c.text && last && del[0].from > 0 && start.doc.sliceString(del[0].from - 1, del[0].from) === " " && start.doc.sliceString(last.to, last.to + 1) === " ") last.to++;
        removed.push(...del);
        if (c.text) typed.push({ at: del.length ? del[0].from : range.from, text: c.text });
        else cuts.push(del.length ? del[0].from : c.from);
      } else if (c.text) {
        typed.push({ at: drop ? settle(start, lay, EditorSelection.cursor(c.from), 0, true).head : c.from, text: c.text });
      }
    }
    // Text never lands inside what goes; it takes the place of the first of it there.
    const outside = (pos: number) => removed.find((r) => r.from < pos && pos < r.to)?.from ?? pos;
    // Dropped text sheds the syntax of the constructs it lands inside (`landing`), or with `plain` all of it.
    const build = (plain: boolean) => {
      const inserts = typed.map((t) => {
        const at = outside(t.at);
        const p = pasted(start, at, drop ? landing(start, at, t.text, plain) : t.text);
        return { at: outside(p.at), insert: p.insert };
      });
      const changes: Change[] = removed.map((r) => ({ ...r }));
      for (const t of inserts) {
        const joined = changes.find((r) => r.from === t.at && r.insert === undefined);
        if (joined) joined.insert = t.insert;
        else changes.push({ from: t.at, to: t.at, insert: t.insert });
      }
      return { inserts, changes };
    };
    let { inserts, changes } = build(false);
    // What goes and what lands leave every construct they partly cover whole (`mended`); a drop that would not lands as plain text.
    let set = drop ? intact(start, changes) : mended(start, changes);
    if (!set) {
      ({ inserts, changes } = build(true));
      set = mended(start, changes);
    }
    if (JSON.stringify(set.toJSON()) === JSON.stringify(tr.changes.toJSON())) return tr;
    const ranges = inserts.length
      ? inserts.map((t) => {
        const at = set.mapPos(t.at, -1);
        return drop ? EditorSelection.range(at, at + t.insert.length) : EditorSelection.cursor(at + t.insert.length);
      })
      : cuts.map((at) => EditorSelection.cursor(set.mapPos(at, -1)));
    return {
      changes: set,
      selection: EditorSelection.create(ranges, Math.min(tr.newSelection.mainIndex, ranges.length - 1)),
      effects: tr.effects,
      userEvent: tr.annotation(Transaction.userEvent),
      scrollIntoView: tr.scrollIntoView,
      annotations: spliced.of(true),
    };
  });
}

/**
 * A table's keys (RICH-11), ahead of every other binding of theirs, and each
 * declining outside a table: Tab and Shift+Tab move between cells, Enter to
 * the same column of the next row, Home and End to the edges of the cell's
 * text, and Shift+Enter writes a `<br>` in the cell as one undo step.
 */
function tableKeymap(field: StateField<Drawn>): Extension {
  type Move = (state: EditorState, lay: Layout, range: SelectionRange) => SelectionRange | null;
  const move = (to: Move): Command => (view) => {
    const { state } = view;
    if (state.selection.ranges.length > 1) return false;
    const range = to(state, state.field(field).layout, state.selection.main);
    if (!range) return false;
    if (!range.eq(state.selection.main)) view.dispatch({ selection: range, scrollIntoView: true, userEvent: "select" });
    return true;
  };
  const edge = (forward: boolean, extend: boolean): Command => move((s, l, r) => cellEdge(s, l, r, forward, extend));
  const lineBreak: Command = (view) => {
    const { state } = view;
    const edit = state.selection.ranges.length > 1 ? null : cellBreak(state, state.selection.main);
    if (!edit) return false;
    view.dispatch({
      changes: edit.changes,
      selection: edit.range,
      scrollIntoView: true,
      userEvent: "input",
      annotations: [spliced.of(true), isolateHistory.of("full")],
    });
    return true;
  };
  return Prec.highest(keymap.of([
    { key: "Tab", run: move((s, l, r) => cellMove(s, l, r, 1)) },
    { key: "Shift-Tab", run: move((s, l, r) => cellMove(s, l, r, -1)) },
    { key: "Enter", run: move(rowMove) },
    { key: "Shift-Enter", run: lineBreak },
    { key: "Home", run: edge(false, false), shift: edge(false, true) },
    { key: "End", run: edge(true, false), shift: edge(true, true) },
  ]));
}

/**
 * Text typed, pasted, dropped or written by a command into a table cell is
 * written as the cell can hold it (`cellText`): a pipe escaped, a line break
 * as `<br>`. A deletion that leaves a backslash just before the pipe ending
 * its cell escapes that backslash, so it does not join the two cells. It runs
 * after `caretFilter`, and sees the text that filter placed.
 */
const cellInput = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move")) || tr.isUserEvent("input.type.compose") || tr.newSelection.ranges.length > 1) return tr;
  const start = tr.startState;
  const changes: { from: number; to: number; insert: string }[] = [];
  const fixes: { fromB: number; toB: number; before: string; text: string; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const text = inserted.toString();
    let insert = text;
    const next = start.doc.sliceString(toA, toA + 1);
    const at = text || next === "|" ? cellAt(start, fromA) : null;
    const cell = at?.row.cells[at.column];
    if (at && cell && fromA >= cell.from && (text ? toA <= cell.to || cellTail(start, at.row, toA)?.column === at.column : toA === cell.to)) {
      const before = start.doc.sliceString(cell.from, fromA);
      insert = cellText(before, text, next);
      if (insert !== text) fixes.push({ fromB, toB, before, text, insert });
    }
    changes.push({ from: fromA, to: toA, insert });
  });
  if (!fixes.length) return tr;
  // The selection keeps its place in the text written, past the backslashes added before it.
  const map = (pos: number) => {
    let shift = 0;
    for (const f of fixes) {
      if (pos < f.fromB) break;
      if (pos <= f.toB) {
        const k = pos - f.fromB;
        return f.fromB + shift + (k >= f.text.length ? f.insert.length : cellText(f.before, f.text.slice(0, k), "").length);
      }
      shift += f.insert.length - f.text.length;
    }
    return pos + shift;
  };
  const { main } = tr.newSelection;
  const isolate = tr.annotation(isolateHistory);
  return {
    changes,
    selection: EditorSelection.single(map(main.anchor), map(main.head)),
    effects: tr.effects,
    userEvent: tr.annotation(Transaction.userEvent),
    scrollIntoView: tr.scrollIntoView,
    annotations: [...(tr.annotation(spliced) ? [spliced.of(true)] : []), ...(isolate ? [isolateHistory.of(isolate)] : [])],
  };
});

/**
 * Every caret at the edge of a table cell's text belongs to that cell: at its
 * end it is drawn, and typed at, before its position, so neither the caret
 * nor the next letter slips past the hidden pipe into the next cell
 * (`caretSide`). It runs after every other filter, on whatever caret they
 * left.
 */
function cellCarets(field: StateField<Drawn>): Extension {
  return Prec.highest(EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged && !tr.selection) return tr;
    const start = tr.startState;
    const tables = start.field(field).layout.tables;
    const sel = tr.newSelection;
    let fixed = false;
    const ranges = sel.ranges.map((r) => {
      if (!r.empty) return r;
      const before = tr.changes.invertedDesc.mapPos(r.head, -1);
      if (!tables.some((t) => t.from <= before && before <= t.to)) return r;
      const side = caretSide(start, r.head, tr.changes);
      if (!side || side === r.assoc) return r;
      fixed = true;
      return EditorSelection.cursor(r.head, side, undefined, r.goalColumn);
    });
    return fixed ? [tr, { selection: EditorSelection.create(ranges, sel.mainIndex), sequential: true }] : tr;
  }));
}

export function livePreview(ctx: PreviewContext): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atomic: RangeSet<Decoration>;
      cells: DecorationSet;
      readonly columns: TableColumns;
      constructor(view: EditorView) {
        this.columns = new TableColumns(view, ctx);
        ({ decorations: this.decorations, atomic: this.atomic, cells: this.cells } = this.draw(view));
      }
      update(u: ViewUpdate) {
        const effects = u.transactions.flatMap((tr) => tr.effects);
        const refreshed = effects.some((e) => e.is(refreshPreview));
        if (u.docChanged) this.columns.map(u.changes);
        if (refreshed) this.columns.refresh();
        if (
          u.docChanged || u.viewportChanged || u.selectionSet || refreshed || effects.some((e) => e.is(redrawColumns))
          || syntaxTree(u.state) !== syntaxTree(u.startState) || u.state.field(blockField) !== u.startState.field(blockField)
        ) {
          ({ decorations: this.decorations, atomic: this.atomic, cells: this.cells } = this.draw(u.view));
        }
      }
      draw(view: EditorView): Inline {
        const lay = view.state.field(blockField).layout;
        return inlineDecorations(view, ctx, lay, drawnRanges(view), (table) => this.columns.widths(table, lay));
      }
      destroy() {
        this.columns.destroy();
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (p) => [
        EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic ?? Decoration.none),
        EditorView.outerDecorations.of((view) => view.plugin(p)?.cells ?? Decoration.none),
      ],
    },
  );
  return [
    blockField,
    plugin,
    cellCarets(blockField),
    tableKeymap(blockField),
    richKeymap(blockField),
    typing(blockField),
    cellInput,
    caretFilter(blockField),
    EditorView.editorAttributes.of({ class: "cm-lp" }),
    EditorView.contentAttributes.of({ spellcheck: "true" }),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        const target = e.target as HTMLElement;
        const link = target.closest?.(".cm-lp-link") as HTMLElement | null;
        if (link && (e.ctrlKey || e.metaKey) && link.dataset.href) {
          e.preventDefault();
          ctx.openLink(link.dataset.href);
          return true;
        }
        // A click on an image selects it, so Delete removes it (RICH-14); a
        // player's own controls keep their clicks.
        const media = target.closest?.(".cm-lp-media") as HTMLElement | null;
        if (media && e.button === 0 && !target.closest("audio, video")) {
          const pos = view.posAtDOM(media);
          const obj = lineSyntax(view.state, view.state.doc.lineAt(pos)).objects.find((o) => o.from <= pos && o.to >= pos);
          if (obj) {
            e.preventDefault();
            view.focus();
            view.dispatch({ selection: EditorSelection.range(obj.from, obj.to), userEvent: "select.pointer" });
            return true;
          }
        }
        return false;
      },
    }),
  ];
}
