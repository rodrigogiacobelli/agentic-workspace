// A citation is `@/` followed by a path from the workspace root: what an
// agent reads, as markdown is what a renderer reads. The slash is what
// separates it from an email address, a CSS at-rule or a scoped package
// (CITE-10). This module parses it as a markdown inline node and draws it in
// the rendered pane: cited media as the media itself, anything else as a chip.

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
  if (text.charCodeAt(pos) !== AT || text.charCodeAt(pos + 1) !== SLASH) return -1;
  if (pos > 0 && /[\w@.]/.test(text[pos - 1])) return -1;
  let end = pos + 2;
  while (end < text.length && !ends(text.charCodeAt(end))) end++;
  while (end > pos + 2 && TRAILING.includes(text[end - 1])) end--;
  return end > pos + 2 ? end : -1;
}

export const citation: MarkdownConfig = {
  defineNodes: [{ name: "Citation", style: t.link }],
  props: [styleTags({ Citation: t.link })],
  parseInline: [
    {
      name: "Citation",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== AT || cx.char(pos + 1) !== SLASH) return -1;
        const text = cx.slice(cx.offset, cx.end);
        const end = citationEnd(text, pos - cx.offset);
        return end < 0 ? -1 : cx.addElement(cx.elt("Citation", pos, cx.offset + end));
      },
    },
  ],
};

/** The workspace-relative path a citation names. */
export function citedPath(text: string): string {
  return text.slice(2);
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
    el.title = this.missing ? `Missing: ${this.path}` : `@/${this.path}`;
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
