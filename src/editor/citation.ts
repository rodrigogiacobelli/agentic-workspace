// A citation is `@` followed by a path from the workspace root: what an
// agent reads, as markdown is what a renderer reads. A path has a slash or
// a dot in it, which keeps `@media` and a bare handle out, and it never
// starts inside a word, which keeps an email address out (CITE-10). The
// older `@/path` form is still read, as is an absolute path an agent wrote;
// `Doc.resolve` tells them apart (ADR-015). This module parses a citation as a
// markdown inline node and builds the chip the rendered pane draws it as,
// with the hover preview an image chip opens; `preview.ts` decides where
// cited media is drawn as the media itself instead (CITE-18).

import { styleTags, tags as t } from "@lezer/highlight";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { WidgetType } from "@codemirror/view";
import { fileIcon, iconElement } from "../components/icons";
import { place } from "../tooltip";

const AT = 64;
const SLASH = 47;

/**
 * Characters that end a citation: whitespace, the punctuation that closes or
 * separates, and `<`, where inline HTML begins (CITE-16).
 */
function ends(code: number): boolean {
  return code <= 32 || code === 41 || code === 93 || code === 60 || code === 62 || code === 34 || code === 39 || code === 96 || code === 124 || code === 42 || code === 126;
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

/**
 * The path a citation names, exactly as written after the `@`. A leading
 * slash stays: whether `/x` is an absolute path or the older root-relative
 * form is the resolution order's question (ADR-015), and a missing path is
 * shown as written (AST-12).
 */
export function citedPath(text: string): string {
  return text.slice(1);
}

/** Each member takes the path as `citedPath` gives it. */
export interface CitationContext {
  /** Whether the path exists: known, or not yet (undefined) — the answer arrives later. */
  exists(path: string): boolean | undefined;
  open(path: string): void;
  /** What the webview loads for the path, or null outside the boundary, and where a missing one was looked for (AST-12). */
  resolve(path: string): { url: string | null; tip: string };
}

/**
 * A cited file, drawn as a chip with the Files panel's icon for it and its
 * name; in the danger colour when it is missing (CITE-07, CITE-11). The one
 * place a chip is built, in prose and in a table cell alike. A click opens the
 * file without moving the caret. An image chip previews the image on hover
 * (CITE-19) and carries no tooltip to show beside it.
 */
export function chipElement(path: string, missing: boolean | undefined, ctx: CitationContext): HTMLElement {
  const file = path.replace(/\/$/, "").split("/").pop() || path;
  const icon = fileIcon(file, path.endsWith("/"));
  const el = document.createElement("span");
  el.className = `cm-lp-chip${missing ? " cm-lp-chip-missing" : ""}`;
  const name = document.createElement("span");
  name.className = "cm-lp-chip-name";
  name.textContent = missing ? path : file;
  el.append(iconElement(icon.name, missing ? undefined : icon.color, "cm-lp-chip-icon"), name);
  if (icon.name === "image") {
    el.addEventListener("mouseenter", () => pendPreview(el, path, ctx));
    el.addEventListener("mouseleave", closePreview);
  } else {
    el.title = missing ? ctx.resolve(path).tip : `@${path}`;
  }
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", (e) => { e.preventDefault(); ctx.open(path); });
  return el;
}

// --- The image preview (CITE-19) -------------------------------------------

/** How long the pointer rests on an image chip before its preview opens. */
const PREVIEW_DELAY = 300;

/** The window's one preview layer: made on first use and hidden between uses, as the tooltip is. */
let layer: HTMLDivElement | null = null;
/** The chip whose preview is pending or shown. */
let hovered: HTMLElement | null = null;
let timer = 0;

/** The pointer entered something other than the hovered chip, or the chip was redrawn away beneath it. */
const onOver = (e: Event) => { if (!hovered?.contains(e.target as Node)) closePreview(); };

/**
 * Starts the preview's delay. What closes it listens only while it is pending
 * or shown: a key, a press, a scroll anywhere, the window losing focus. None
 * of them is consumed, so a key reaches whatever it was going to.
 */
function pendPreview(chip: HTMLElement, path: string, ctx: CitationContext): void {
  closePreview();
  hovered = chip;
  timer = window.setTimeout(() => showPreview(chip, path, ctx), PREVIEW_DELAY);
  document.addEventListener("mouseover", onOver, true);
  for (const type of ["keydown", "mousedown", "scroll"]) document.addEventListener(type, closePreview, true);
  window.addEventListener("blur", closePreview);
}

function closePreview(): void {
  if (!hovered) return;
  window.clearTimeout(timer);
  hovered = null;
  if (layer) layer.hidden = true;
  document.removeEventListener("mouseover", onOver, true);
  for (const type of ["keydown", "mousedown", "scroll"]) document.removeEventListener(type, closePreview, true);
  window.removeEventListener("blur", closePreview);
}

/**
 * The image under the chip, scaled into 720 × 540 px and half the window,
 * whichever is smaller, and never past its own size, with its name and pixel
 * size under it; for a file that is missing, the placeholder a missing image
 * draws and where it was looked for. The size is worked out here from the
 * image's own, because the webview drops an intrinsic size inside a CSS
 * `min()` (`standards-linux-desktop`).
 */
function showPreview(chip: HTMLElement, path: string, ctx: CitationContext): void {
  const reveal = (...content: HTMLElement[]) => {
    // The pointer has moved on, or the chip was redrawn while the image loaded.
    if (hovered !== chip) return;
    if (!chip.isConnected) return closePreview();
    if (!layer) {
      layer = document.body.appendChild(document.createElement("div"));
      layer.className = "image-preview";
    }
    layer.replaceChildren(...content);
    layer.hidden = false;
    place(layer, chip);
  };
  const line = (cls: string, text: string) => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  if (!chip.isConnected) return closePreview();
  const { url, tip } = ctx.resolve(path);
  const missing = () => reveal(line("cm-lp-broken", `Missing asset: ${path}`), line("image-preview-tip", tip));
  if (!url || ctx.exists(path) === false) return missing();
  const img = new Image();
  img.onerror = missing;
  img.onload = () => {
    // An SVG with no size of its own gets the size CSS gives any such image.
    const w = img.naturalWidth || 300;
    const h = img.naturalHeight || 150;
    const scale = Math.min(1, Math.min(720, window.innerWidth / 2) / w, Math.min(540, window.innerHeight / 2) / h);
    img.width = Math.max(1, Math.round(w * scale));
    img.height = Math.max(1, Math.round(h * scale));
    const caption = document.createElement("div");
    caption.className = "image-preview-caption";
    caption.style.width = `${Math.max(img.width, 160)}px`;
    caption.append(line("image-preview-name", path.split("/").pop() || path));
    if (img.naturalWidth) caption.append(line("image-preview-size", `${img.naturalWidth} × ${img.naturalHeight}`));
    reveal(img, caption);
  };
  img.src = url;
}

/** A chip inside `dom` is going away: its preview goes with it rather than floating over whatever is drawn in its place. */
export function releasePreview(dom: HTMLElement): void {
  if (hovered && dom.contains(hovered)) closePreview();
}

export class ChipWidget extends WidgetType {
  constructor(readonly path: string, readonly missing: boolean | undefined, readonly ctx: CitationContext) { super(); }
  toDOM() { return chipElement(this.path, this.missing, this.ctx); }
  // The tooltip names where a missing file was looked for, which moves when the worktree family does.
  eq(other: ChipWidget) { return other.path === this.path && other.missing === this.missing && other.ctx.resolve(other.path).tip === this.ctx.resolve(this.path).tip; }
  destroy(dom: HTMLElement) { releasePreview(dom); }
  ignoreEvent() { return true; }
}
