// Rendering markdown in place: the syntax tree that highlights the source also
// decides what to hide, style or replace with a widget. Syntax stays visible
// on the lines the selection touches, so what is being edited is always the
// source. See ADR-011.

import { syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect, StateField, type EditorSelection, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef, Tree } from "@lezer/common";
import { ChipWidget, citedPath, type CitationContext } from "./citation";

export interface PreviewContext {
  /** Turns a link target, relative to the note, into something the webview can load, or null. */
  resolveUrl(href: string): string | null;
  /** The same for a path from the workspace root, as a citation names it. */
  resolveRoot(path: string): string | null;
  openLink(href: string): void;
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

function selectionLines(state: EditorState, selection: EditorSelection): LineSpan[] {
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
  constructor(readonly href: string, readonly alt: string, readonly url: string | null) { super(); }
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
      wrap.appendChild(ph);
    };
    if (!url) { broken(); return wrap; }
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
  eq(other: MediaWidget) { return other.href === this.href && other.alt === this.alt; }
  ignoreEvent(e: Event) { return e.type !== "mousedown" && e.type !== "click"; }
}

function inlineHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_]+)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="cm-lp-link" data-href="$2">$1</span>');
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

class TableWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  toDOM() {
    const lines = this.text.split("\n").filter((l) => l.trim());
    const table = document.createElement("table");
    table.className = "cm-lp-table";
    const aligns = lines[1] ? splitRow(lines[1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "")) : [];
    lines.forEach((line, i) => {
      if (i === 1) return;
      const tr = document.createElement("tr");
      splitRow(line).forEach((cell, j) => {
        const td = document.createElement(i === 0 ? "th" : "td");
        td.innerHTML = inlineHtml(cell);
        if (aligns[j]) td.style.textAlign = aligns[j];
        tr.appendChild(td);
      });
      (i === 0 ? table.createTHead() : table.tBodies[0] ?? table.createTBody()).appendChild(tr);
    });
    return table;
  }
  eq(other: TableWidget) { return other.text === this.text; }
  ignoreEvent(e: Event) { return e.type !== "mousedown"; }
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

function blockDecorations(state: EditorState): DecorationSet {
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
          const widget = n.name === "Table" ? new TableWidget(text) : new FrontmatterWidget(text, frontmatterRows(state, from, to));
          ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
        }
        return false;
      }
      return n.name === "Document" || n.name === "Blockquote" || n.name === "BulletList" || n.name === "OrderedList" || n.name === "ListItem";
    },
  });
  return Decoration.set(ranges, true);
}

const blockField = StateField.define<DecorationSet>({
  create: blockDecorations,
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return blockDecorations(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- Inline decorations: a view plugin over the visible ranges.

function inlineDecorations(view: EditorView, ctx: PreviewContext): DecorationSet {
  const { state } = view;
  const tree = syntaxTree(state);
  const spans = selectionLines(state, state.selection);
  const marks: Range<Decoration>[] = [];
  const lines: Range<Decoration>[] = [];
  const hide = (from: number, to: number) => { if (to > from) marks.push(Decoration.replace({}).range(from, to)); };
  const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>) => {
    if (to > from) marks.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to));
  };
  const lineClass = (from: number, to: number, cls: string) => {
    const a = state.doc.lineAt(from).number;
    const b = state.doc.lineAt(Math.max(from, to - 1)).number;
    for (let n = a; n <= b; n++) lines.push(Decoration.line({ class: cls }).range(state.doc.line(n).from));
  };
  const isRevealed = (n: SyntaxNodeRef) => revealed(state, spans, n.from, n.to);

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
          case "Image": {
            if (isRevealed(n)) return true;
            const text = state.doc.sliceString(n.from, n.to);
            const m = /^!\[([^\]]*)\]\(\s*<?([^\s>)]+)>?(?:\s+"[^"]*")?\s*\)$/.exec(text);
            if (!m) return true;
            marks.push(Decoration.replace({ widget: new MediaWidget(m[2], m[1], ctx.resolveUrl(m[2])) }).range(n.from, n.to));
            return false;
          }
          case "Citation": {
            // Cited media renders as the media; anything else is a chip (CITE-06, CITE-07).
            if (isRevealed(n)) return false;
            const path = citedPath(state.doc.sliceString(n.from, n.to));
            const kind = mediaKind(path);
            const widget = kind !== "file"
              ? new MediaWidget(path, path.split("/").pop() ?? path, ctx.resolveRoot(path))
              : new ChipWidget(path, (() => { const e = ctx.citation.exists(path.replace(/\/$/, "")); return e === undefined ? undefined : !e; })(), ctx.citation);
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
        const refreshed = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshPreview)));
        if (u.docChanged || u.viewportChanged || u.selectionSet || refreshed || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          this.decorations = inlineDecorations(u.view, ctx);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [
    blockField,
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
