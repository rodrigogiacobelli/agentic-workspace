// Rendering markdown in place: the syntax tree that highlights the source also
// decides what to hide, style or replace with a widget. Syntax stays visible
// on the lines the selection touches while the view has focus, so what is
// being edited is always the source, and a pane only being read — the
// rendered side of a split — draws every line. See ADR-011.

import { syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect, StateField, type EditorSelection, type Extension, type Line, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { ChipWidget, chipElement, citedPath, releasePreview, type CitationContext } from "./citation";

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

// --- Selection geometry --------------------------------------------------

interface LineSpan { from: number; to: number }

const setFocused = StateEffect.define<boolean>();

const focused = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) return e.value;
    return value;
  },
});

function selectionLines(state: EditorState, selection: EditorSelection): LineSpan[] {
  if (!state.field(focused)) return [];
  return selection.ranges.map((r) => ({
    from: state.doc.lineAt(r.from).number,
    to: state.doc.lineAt(r.to).number,
  }));
}

function revealed(state: EditorState, spans: LineSpan[], from: number, to: number): boolean {
  const a = state.doc.lineAt(from).number;
  const b = state.doc.lineAt(Math.max(from, to - 1)).number;
  return spans.some((s) => s.from <= b && s.to >= a);
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

/** A row's cells in column order; an empty cell has no node of its own, only the pipes around it. */
function rowCells(row: SyntaxNode): (SyntaxNode | null)[] {
  const cells: (SyntaxNode | null)[] = [];
  let cell: SyntaxNode | null = null;
  let leading = true;
  for (let c = row.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableCell") cell = c;
    else if (c.name === "TableDelimiter") { if (!leading) cells.push(cell); cell = null; }
    leading = false;
  }
  if (cell) cells.push(cell);
  return cells;
}

/**
 * A GFM table, drawn from the document's own parse: each cell's inline syntax
 * tree is walked into DOM, so a cell renders what a paragraph renders (ED-52)
 * and the document's text never reaches the page as HTML.
 */
class TableWidget extends WidgetType {
  constructor(
    readonly text: string,
    /** Where `text` starts in the document. */
    readonly base: number,
    readonly table: SyntaxNode,
    /** What is known of each cited file; a new answer draws the table again. */
    readonly known: string,
    readonly ctx: PreviewContext,
  ) { super(); }

  toDOM(view: EditorView) {
    const { ctx } = this;
    const slice = (from: number, to: number) => this.text.slice(from - this.base, to - this.base);
    const fill = (el: HTMLElement, node: SyntaxNode, from = node.from, to = node.to) => {
      let pos = from;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.from < from || c.to > to) continue;
        if (c.from > pos) el.append(slice(pos, c.from));
        inline(el, c);
        pos = c.to;
      }
      if (to > pos) el.append(slice(pos, to));
    };
    const inline = (el: HTMLElement, n: SyntaxNode) => {
      const text = slice(n.from, n.to);
      const wrap = (tag: string) => { const e = el.appendChild(document.createElement(tag)); fill(e, n); return e; };
      switch (n.name) {
        case "EmphasisMark": case "StrikethroughMark": case "CodeMark": return;
        case "Emphasis": wrap("em"); return;
        case "StrongEmphasis": wrap("strong"); return;
        case "Strikethrough": wrap("del"); return;
        case "InlineCode": wrap("code").className = "cm-lp-code"; return;
        case "Escape": el.append(text.slice(1)); return;
        case "HTMLTag": {
          if (/^<br\s*(\/\s*)?>$/i.test(text)) { el.append(document.createElement("br")); return; }
          const tag = el.appendChild(document.createElement("span"));
          tag.className = "cm-lp-html";
          tag.textContent = text;
          return;
        }
        case "Citation": {
          const path = citedPath(text);
          el.append(chipElement(path, citationMissing(ctx, path), ctx.citation));
          return;
        }
        case "Image": case "Link": case "Autolink": case "URL": {
          const url = n.name === "URL" ? n : n.getChild("URL");
          const href = url ? slice(url.from, url.to).replace(/^<|>$/g, "") : "";
          const marks = n.getChildren("LinkMark");
          if (!href || (n.name !== "URL" && marks.length < 2)) { el.append(text); return; }
          if (n.name === "Image") {
            const target = ctx.resolve(href, true);
            el.append(new MediaWidget(href, slice(marks[0].to, marks[1].from), target.url, target.tip, imageMissing(ctx, href, target)).toDOM(view));
            return;
          }
          const link = el.appendChild(document.createElement("span"));
          link.className = "cm-lp-link";
          link.dataset.href = href;
          link.title = href;
          if (n.name === "Link") fill(link, n, marks[0].to, marks[1].from);
          else link.textContent = href;
          return;
        }
        default: el.append(text);
      }
    };

    const box = document.createElement("div");
    box.className = "cm-lp-table-wrap";
    const table = box.appendChild(document.createElement("table"));
    table.className = "cm-lp-table";
    const delimiter = this.table.getChild("TableDelimiter");
    const aligns = delimiter ? splitRow(slice(delimiter.from, delimiter.to)).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "")) : [];
    let columns = 0;
    for (let row = this.table.firstChild; row; row = row.nextSibling) {
      const head = row.name === "TableHeader";
      if (!head && row.name !== "TableRow") continue;
      const cells = rowCells(row);
      if (head) columns = cells.length;
      const tr = (head ? table.createTHead() : table.tBodies[0] ?? table.createTBody()).insertRow();
      // A short row is padded and a long one cut to the header's width, as GFM reads them.
      for (let j = 0; j < columns; j++) {
        const td = tr.appendChild(document.createElement(head ? "th" : "td"));
        if (aligns[j]) td.style.textAlign = aligns[j];
        const cell = td.appendChild(document.createElement("div"));
        cell.className = "cm-lp-cell";
        const node = cells[j];
        if (node) fill(cell, node);
      }
    }
    return box;
  }
  eq(other: TableWidget) { return other.text === this.text && other.known === this.known; }
  destroy(dom: HTMLElement) { releasePreview(dom); }
  // A chip opens its file and a player plays without moving the caret (ED-53);
  // any other press enters the table's source, where a Ctrl+click on a link is
  // taken first by the handler in `livePreview`.
  ignoreEvent(e: Event) { return e.type !== "mousedown" || !!(e.target as HTMLElement).closest?.(".cm-lp-chip, audio, video"); }
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
    const table = document.createElement("table");
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
    return table;
  }
  eq(other: FrontmatterWidget) { return other.text === this.text; }
  ignoreEvent() { return true; }
}

// --- Block replacements (tables, frontmatter): a state field, because
// replacing whole lines changes the vertical layout outside the viewport.

function blockDecorations(state: EditorState, ctx: PreviewContext): DecorationSet {
  const tree: Tree = syntaxTree(state);
  const spans = selectionLines(state, state.selection);
  const ranges: Range<Decoration>[] = [];
  tree.iterate({
    enter(n: SyntaxNodeRef) {
      if (n.name === "Table" || n.name === "Frontmatter") {
        const from = state.doc.lineAt(n.from).from;
        const to = state.doc.lineAt(Math.max(n.from, n.to - 1)).to;
        if (!revealed(state, spans, from, to)) {
          const text = state.doc.sliceString(from, to);
          let widget: WidgetType;
          if (n.name === "Table") {
            // Where each cited file and image leads, and whether it is there:
            // the table draws again when an answer arrives, the worktree
            // family changes or the note moves.
            const known: unknown[] = [];
            n.node.cursor().iterate((c) => {
              if (c.name === "Citation") {
                const path = citedPath(state.doc.sliceString(c.from, c.to));
                known.push(citationMissing(ctx, path), ctx.citation.resolve(path).tip);
              } else if (c.name === "Image") {
                const url = c.node.getChild("URL");
                if (!url) return;
                const href = state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
                const target = ctx.resolve(href, true);
                known.push(target.url, imageMissing(ctx, href, target));
              }
            });
            widget = new TableWidget(text, from, n.node, known.join(), ctx);
          } else {
            widget = new FrontmatterWidget(text, frontmatterRows(state, from, to));
          }
          ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
        }
        return false;
      }
      return n.name === "Document" || n.name === "Blockquote" || n.name === "BulletList" || n.name === "OrderedList" || n.name === "ListItem";
    },
  });
  return Decoration.set(ranges, true);
}

/** Block decorations come from a state field, which reaches the preview's context through this closure. */
function blockField(ctx: PreviewContext) {
  return StateField.define<DecorationSet>({
    create: (state) => blockDecorations(state, ctx),
    update(value, tr) {
      if (
        tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshPreview))
        || tr.state.field(focused) !== tr.startState.field(focused) || syntaxTree(tr.state) !== syntaxTree(tr.startState)
      ) return blockDecorations(tr.state, ctx);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// --- Inline decorations: a view plugin over the visible ranges.

function inlineDecorations(view: EditorView, ctx: PreviewContext): DecorationSet {
  const { state } = view;
  const tree = syntaxTree(state);
  const spans = selectionLines(state, state.selection);
  const marks: Range<Decoration>[] = [];
  const lines: Range<Decoration>[] = [];
  // A plugin may not replace a line break: a link title that runs onto the
  // next line keeps its syntax visible rather than breaking the pane.
  const hide = (from: number, to: number) => { if (to > from && !state.doc.sliceString(from, to).includes("\n")) marks.push(Decoration.replace({}).range(from, to)); };
  const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>) => {
    if (to > from) marks.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to));
  };
  const lineClass = (from: number, to: number, cls: string) => {
    const a = state.doc.lineAt(from).number;
    const b = state.doc.lineAt(Math.max(from, to - 1)).number;
    for (let n = a; n <= b; n++) lines.push(Decoration.line({ class: cls }).range(state.doc.line(n).from));
  };
  const isRevealed = (n: SyntaxNodeRef) => revealed(state, spans, n.from, n.to);
  /** `citationsOnly` for the line at `pos`, worked out once per line however many citations it holds. */
  const own = new Map<number, boolean>();
  const alone = (pos: number) => {
    const line = state.doc.lineAt(pos);
    let only = own.get(line.from);
    if (only === undefined) own.set(line.from, (only = citationsOnly(state, tree, line)));
    return only;
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(n) {
        const name = n.name;
        if (name === "Table" || name === "Frontmatter") {
          if (isRevealed(n)) lineClass(n.from, n.to, "cm-lp-src");
          return false;
        }
        if (/^ATXHeading[1-6]$/.test(name)) {
          lineClass(n.from, n.to, `cm-lp-h${name.slice(-1)}`);
          return true;
        }
        if (name === "SetextHeading1" || name === "SetextHeading2") {
          lineClass(n.from, state.doc.lineAt(n.from).to, `cm-lp-h${name.slice(-1)}`);
          return true;
        }
        switch (name) {
          case "HeaderMark": {
            const parent = n.node.parent?.name ?? "";
            if (parent.startsWith("ATXHeading")) {
              if (!isRevealed(n)) hide(n.from, state.doc.sliceString(n.to, n.to + 1) === " " ? n.to + 1 : n.to);
            } else if (!isRevealed(n)) {
              mark(n.from, n.to, "cm-lp-dim");
            }
            return false;
          }
          case "Emphasis": mark(n.from, n.to, "cm-lp-em"); return true;
          case "StrongEmphasis": mark(n.from, n.to, "cm-lp-strong"); return true;
          case "Strikethrough": mark(n.from, n.to, "cm-lp-strike"); return true;
          case "EmphasisMark":
          case "StrikethroughMark":
            if (!isRevealed(n)) hide(n.from, n.to);
            return false;
          case "InlineCode": mark(n.from, n.to, "cm-lp-code"); return true;
          case "CodeMark":
            if (n.node.parent?.name === "InlineCode") { if (!isRevealed(n)) hide(n.from, n.to); }
            else mark(n.from, n.to, "cm-lp-dim");
            return false;
          case "CodeInfo": mark(n.from, n.to, "cm-lp-codeinfo"); return false;
          case "FencedCode": lineClass(n.from, n.to, "cm-lp-fence"); return true;
          case "CodeBlock": lineClass(n.from, n.to, "cm-lp-fence"); return true;
          case "HTMLBlock": lineClass(n.from, n.to, "cm-lp-src"); return false;
          case "HTMLTag": mark(n.from, n.to, "cm-lp-html"); return false;
          case "Blockquote": lineClass(n.from, n.to, "cm-lp-quote"); return true;
          case "QuoteMark":
            if (!isRevealed(n)) hide(n.from, state.doc.sliceString(n.to, n.to + 1) === " " ? n.to + 1 : n.to);
            return false;
          case "HorizontalRule":
            if (!isRevealed(n)) marks.push(Decoration.replace({ widget: new HrWidget() }).range(n.from, n.to));
            return false;
          case "ListMark": {
            const item = n.node.parent;
            const list = item?.parent;
            if (list?.name === "BulletList" && !isRevealed(n)) {
              let level = 0;
              for (let p = list.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") level++;
              marks.push(Decoration.replace({ widget: new BulletWidget(level) }).range(n.from, n.to));
            } else {
              mark(n.from, n.to, "cm-lp-listmark");
            }
            return false;
          }
          case "TaskMarker": {
            if (!isRevealed(n)) {
              const checked = /x/i.test(state.doc.sliceString(n.from, n.to));
              marks.push(Decoration.replace({ widget: new TaskWidget(checked, n.from) }).range(n.from, n.to));
            }
            return false;
          }
          case "Escape":
            if (!isRevealed(n)) hide(n.from, n.from + 1);
            return false;
          // Media being edited stays drawn after its source, so an image on
          // the only line of a note is still seen while that line is edited.
          case "Image": {
            const text = state.doc.sliceString(n.from, n.to);
            const m = /^!\[([^\]]*)\]\(\s*<?([^\s>)]+)>?(?:\s+"[^"]*")?\s*\)$/.exec(text);
            if (!m) return true;
            const target = ctx.resolve(m[2], true);
            const widget = new MediaWidget(m[2], m[1], target.url, target.tip, imageMissing(ctx, m[2], target));
            // A plugin may not replace a line break, and alt text can hold one.
            const multiline = state.doc.lineAt(n.from).number !== state.doc.lineAt(n.to).number;
            if (isRevealed(n) || multiline) { marks.push(Decoration.widget({ widget, side: 1 }).range(n.to)); return true; }
            marks.push(Decoration.replace({ widget }).range(n.from, n.to));
            return false;
          }
          case "Citation": {
            // Cited media on a line of its own is the media; anywhere else it
            // is a chip, as any other cited file is (CITE-18, CITE-07).
            const path = citedPath(state.doc.sliceString(n.from, n.to));
            let media: MediaWidget | null = null;
            if (mediaKind(path) !== "file" && alone(n.from)) {
              const target = ctx.resolve(path, false);
              media = new MediaWidget(path, path.split("/").pop() ?? path, target.url, target.tip);
            }
            if (isRevealed(n)) {
              if (media) marks.push(Decoration.widget({ widget: media, side: 1 }).range(n.to));
              return false;
            }
            const widget = media ?? new ChipWidget(path, citationMissing(ctx, path), ctx.citation);
            marks.push(Decoration.replace({ widget }).range(n.from, n.to));
            return false;
          }
          case "Link": {
            const node = n.node;
            const children: { name: string; from: number; to: number }[] = [];
            for (let c = node.firstChild; c; c = c.nextSibling) children.push({ name: c.name, from: c.from, to: c.to });
            const open = children.find((c) => c.name === "LinkMark");
            const close = children.filter((c) => c.name === "LinkMark")[1];
            const url = children.find((c) => c.name === "URL");
            const href = url ? state.doc.sliceString(url.from, url.to) : "";
            if (!open || !close) { mark(n.from, n.to, "cm-lp-link", { "data-href": href }); return false; }
            const textFrom = open.to;
            const textTo = close.from;
            mark(textFrom, textTo, "cm-lp-link", { "data-href": href, title: href });
            if (!isRevealed(n)) {
              hide(n.from, textFrom);
              hide(textTo, n.to);
            }
            return false;
          }
          case "Autolink":
          case "URL": {
            const href = state.doc.sliceString(n.from, n.to).replace(/^<|>$/g, "");
            mark(n.from, n.to, "cm-lp-link", { "data-href": href });
            return false;
          }
        }
        return true;
      },
    });
  }
  return Decoration.set([...marks, ...lines], true);
}

export function livePreview(ctx: PreviewContext): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = inlineDecorations(view, ctx); }
      update(u: ViewUpdate) {
        const refreshed = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshPreview) || e.is(setFocused)));
        if (u.docChanged || u.viewportChanged || u.selectionSet || refreshed || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          this.decorations = inlineDecorations(u.view, ctx);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [
    focused,
    EditorView.focusChangeEffect.of((_, focusing) => setFocused.of(focusing)),
    blockField(ctx),
    plugin,
    EditorView.editorAttributes.of({ class: "cm-lp" }),
    EditorView.contentAttributes.of({ spellcheck: "true" }),
    EditorView.domEventHandlers({
      mousedown(e) {
        const target = (e.target as HTMLElement).closest?.(".cm-lp-link") as HTMLElement | null;
        if (target && (e.ctrlKey || e.metaKey) && target.dataset.href) {
          e.preventDefault();
          ctx.openLink(target.dataset.href);
          return true;
        }
        return false;
      },
    }),
  ];
}
