// A citation is `@` followed by a path from the workspace root: what an
// agent reads, as markdown is what a renderer reads. A path has a slash or
// a dot in it, which keeps `@media` and a bare handle out, and it never
// starts inside a word, which keeps an email address out (CITE-10). The
// older `@/path` form is still read. This module parses a citation as a
// markdown inline node and draws it in the rendered pane: cited media as
// the media itself, anything else as a chip.

import { styleTags, tags as t } from "@lezer/highlight";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { WidgetType, type EditorView } from "@codemirror/view";

const AT = 64;
const SLASH = 47;

/** Characters that end a citation: whitespace and the punctuation that closes or separates. */
function ends(code: number): boolean {
  return code <= 32 || code === 41 || code === 93 || code === 62 || code === 34 || code === 39 || code === 96 || code === 124 || code === 42 || code === 126;
}

const TRAILING = ".,:;!?";

/** Where a citation starting at `pos` ends, or -1 when there is none. */
export function citationEnd(text: string, pos: number): number {
  if (text.charCodeAt(pos) !== AT) return -1;
  if (pos > 0 && /[\w@./]/.test(text[pos - 1])) return -1;
  const start = text.charCodeAt(pos + 1) === SLASH ? pos + 2 : pos + 1;
  let end = start;
  while (end < text.length && !ends(text.charCodeAt(end))) end++;
  while (end > start && TRAILING.includes(text[end - 1])) end--;
  const path = text.slice(start, end);
  if (!path || !(path.includes("/") || path.includes("."))) return -1;
  return end;
}

export const citation: MarkdownConfig = {
  defineNodes: [{ name: "Citation", style: t.link }],
  props: [styleTags({ Citation: t.link })],
  parseInline: [
    {
      name: "Citation",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== AT) return -1;
        const text = cx.slice(cx.offset, cx.end);
        const end = citationEnd(text, pos - cx.offset);
        return end < 0 ? -1 : cx.addElement(cx.elt("Citation", pos, cx.offset + end));
      },
    },
  ],
};

/** The workspace-relative path a citation names, in either form. */
export function citedPath(text: string): string {
  const body = text.slice(1);
  return body.startsWith("/") ? body.slice(1) : body;
}

export interface CitationContext {
  /** Whether the path exists: known, or not yet (undefined) — the answer arrives later. */
  exists(path: string): boolean | undefined;
  open(path: string): void;
}

/** A cited file, drawn as a chip with its name; in the danger colour when it is missing (CITE-07, CITE-11). */
export class ChipWidget extends WidgetType {
  constructor(readonly path: string, readonly missing: boolean | undefined, readonly ctx: CitationContext) { super(); }
  toDOM(_view: EditorView) {
    const el = document.createElement("span");
    el.className = `cm-lp-chip${this.missing ? " cm-lp-chip-missing" : ""}`;
    el.title = this.missing ? `Missing: ${this.path}` : `@${this.path}`;
    const icon = document.createElement("span");
    icon.className = "cm-lp-chip-icon";
    icon.textContent = this.path.endsWith("/") ? "▤" : "▢";
    const name = document.createElement("span");
    name.textContent = this.missing ? this.path : this.path.replace(/\/$/, "").split("/").pop() || this.path;
    el.append(icon, name);
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => { e.preventDefault(); this.ctx.open(this.path); });
    return el;
  }
  eq(other: ChipWidget) { return other.path === this.path && other.missing === this.missing; }
  ignoreEvent() { return true; }
}
