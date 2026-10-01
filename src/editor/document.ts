// One open file: a source view that owns the document and its history, and a
// rendered view over the same document created on demand. See ADR-011.

import { Annotation, Compartment, EditorState, Text, type Extension, type StateEffect } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  dropCursor, highlightActiveLine, gutter, GutterMarker, scrollPastEnd,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, undo } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { diff, unifiedMergeView } from "@codemirror/merge";
import { tags as t } from "@lezer/highlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../api";
import { NOTICE_DWELL_MS } from "../notice";
import * as settings from "../settings";
import { languageExtension, type LanguageId } from "./languages";
import type { BlameLine, StoredAsset, Workspace } from "../types";
import { livePreview, mediaKind, refreshPreview, type PreviewContext, type Resolved } from "./preview";
import { typingHelpers } from "./typing";
import { richFormatting } from "./toolbar";
import { MARKS_LIMIT, changeField, changeGutter, changeRuler, setBase } from "./changes";

export type Mode = "source" | "split" | "rich";
export const MODES: Mode[] = ["source", "split", "rich"];

/** A change that arrived from the other view; never forwarded back. */
const forwarded = Annotation.define<boolean>();
/** A change that came from disk rather than the user. */
export const external = Annotation.define<boolean>();

export interface DocHooks {
  /** Follow a link or a chip to a file inside the workspace. */
  openFile(relPath: string, preview: boolean): void;
  /** Open a file in another open workspace, switching to it (CITE-17). */
  openIn(workspaceId: string, relPath: string, preview: boolean): void;
  /** Show a folder in the Explorer of the open workspace holding it, as Show in Explorer does (CITE-22c). */
  reveal(workspaceId: string, relPath: string): void;
  /** The open workspaces as last published: whose worktree family a path reaches, and which one holds a file. */
  workspaces(): Workspace[];
  notice(message: string): void;
  /** Show a commit, from a blame annotation. */
  showCommit(hash: string): void;
}

class BlameMarker extends GutterMarker {
  constructor(readonly info: BlameLine, readonly onClick: () => void) { super(); }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-blame-line";
    el.textContent = `${this.info.short} ${this.info.author} · ${this.info.date}`;
    el.title = `${this.info.hash}\n${this.info.author} · ${this.info.date}`;
    el.onclick = this.onClick;
    return el;
  }
  eq(other: BlameMarker) { return other.info.hash === this.info.hash && other.info.line === this.info.line; }
}

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.propertyName, t.definition(t.propertyName), t.typeName, t.className], color: "var(--syn-property)" },
  { tag: t.tagName, color: "var(--syn-tag)" },
  { tag: t.attributeName, color: "var(--syn-attribute)" },
  { tag: t.heading, color: "var(--syn-heading)", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "var(--syn-link)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.escape], color: "var(--syn-meta)" },
  { tag: [t.operator, t.separator, t.punctuation], color: "var(--syn-punctuation)" },
  { tag: t.monospace, fontFamily: "var(--mono)" },
]);

const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "var(--editor-size)", lineHeight: "1.55" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-faint)", borderRight: "1px solid var(--border)" },
  ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)", color: "var(--fg-dim)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
  // The selection is drawn above the text rather than beneath it, so a line
  // highlight, a code block or a widget with its own background cannot hide
  // it; a blend mode in styles.css keeps the text legible through it.
  ".cm-selectionLayer": { zIndex: "1 !important", pointerEvents: "none" },
  ".cm-selectionBackground": { backgroundColor: "var(--selection) !important", opacity: "0.55" },
  "&.cm-focused .cm-selectionBackground": { opacity: "1" },
  ".cm-matchingBracket": { backgroundColor: "var(--selection)", outline: "1px solid var(--accent)" },
  ".cm-searchMatch": { backgroundColor: "rgba(255, 200, 0, 0.25)" },
  ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-panel input, .cm-panel button": { color: "var(--fg)", background: "var(--bg)", border: "1px solid var(--border)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-hover)", color: "var(--fg-dim)", border: "none" },
});

/**
 * `parts` with `.` and `..` applied, or null when a `..` climbs above the
 * first: a link that climbs out is never clamped to the top, which would name
 * a different file.
 */
function normalize(parts: string[]): string[] | null {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p !== "..") out.push(p);
    else if (out.pop() === undefined) return null;
  }
  return out;
}

/** Where a file opens: a workspace, and the path inside it. */
interface Home {
  workspaceId: string;
  rel: string;
}

/** Whether the absolute path `abs` is `dir` or lies under it. */
function under(dir: string, abs: string): boolean {
  return abs === dir || abs.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/**
 * The directories beyond its own root that a workspace's documents reach, and
 * those inside them they do not: `tree::family` in the backend, which
 * `stat_entries` and the asset protocol hold to (ADR-015).
 */
function family(ws: Workspace | undefined): { reached: string[]; excluded: string[] } {
  const git = ws?.git;
  if (!git?.isRepo) return { reached: [], excluded: [] };
  const paths = (main: boolean) => git.worktrees.filter((w) => w.isMain === main).map((w) => w.path);
  return git.isWorktree ? { reached: paths(true), excluded: paths(false) } : { reached: paths(false), excluded: [] };
}

/**
 * The link from a note in `fromDir` to the workspace path `to`, both from the
 * workspace root: the inverse of `Doc.resolve` for a link, and the path `assets.rs`'s
 * `relative_link` gives a stored asset.
 */
function relativeLink(fromDir: string, to: string): string {
  const from = fromDir.split("/").filter((s) => s && s !== ".");
  const target = to.split("/").filter((s) => s && s !== ".");
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) common++;
  return [...from.slice(common).map(() => ".."), ...target.slice(common)].join("/");
}

export class Doc {
  readonly source: EditorView;
  rich: EditorView | null = null;
  mode: Mode;
  saved: Text;
  dirty = false;
  /** The file no longer exists on disk. */
  detached = false;
  /** Disk content that arrived while the buffer had unsaved changes. */
  conflict: string | null = null;
  reloadedAt = 0;
  diffOpen = false;
  /** Unsaved changes were restored from a draft after a crash. */
  restored = false;
  private draftTimer: number | null = null;
  private root: HTMLDivElement | null = null;
  /**
   * Where the document owes its reader a scroll, per view: where it was when
   * the document was last taken off screen, the tab's saved line, or a jump.
   * Each mount asks for it again, and CodeMirror holds it until it measures
   * the view laid out. It is paid when the view next scrolls with a height:
   * a document mounted behind a panel, or taken off again at once — React's
   * strict mode does that — still owes it.
   */
  private owed = new Map<EditorView, StateEffect<unknown>>();
  /** Where each view last was while laid out; hidden behind a panel, a scroller reads 0. */
  private lastScroll = new Map<EditorView, StateEffect<unknown>>();
  private listeners = new Set<() => void>();
  private mergeComp = new Compartment();
  /** The typing helpers read the file's name for its comment token, so they
   *  are reconfigured rather than fixed when the file moves. */
  private typingComp = new Compartment();
  private blameComp = new Compartment();
  /** The change gutter, which steps aside while the conflict diff draws its own. */
  private changeComp = new Compartment();
  blameOn = false;
  /** The index's copy of the file as last read, which the change marks compare against (GIT-14). */
  private base: string | null | undefined = undefined;
  /** Whether the index may have moved since it was read. */
  private baseStale = true;
  private baseReads = 0;
  private autosaveTimer: number | null = null;
  private viewTimer: number | null = null;
  private existence = new Map<string, boolean>();
  /** The worktree family the rendered pane last resolved against. */
  private familyKey = "";
  private pendingExists = new Set<string>();
  private existsTimer: number | null = null;
  /** Where a split's last sync left the other pane, so its echo is known. */
  private echoScroll: { view: EditorView; top: number } | null = null;
  /** Views whose scroll is already followed. */
  private viewStateBound = new Set<EditorView>();
  private disposed = false;

  constructor(
    readonly id: string,
    readonly workspaceId: string,
    readonly workspacePath: string,
    /** Relative to the workspace, and not fixed: a rename moves the open tab. */
    public path: string,
    text: string,
    readonly language: LanguageId,
    mode: Mode,
    readonly hooks: DocHooks,
  ) {
    this.mode = language === "markdown" ? mode : "source";
    this.saved = Text.of(text.split("\n"));
    this.source = new EditorView({
      state: EditorState.create({ doc: text, extensions: this.sourceExtensions() }),
    });
  }

  get isMarkdown(): boolean {
    return this.language === "markdown";
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    this.listeners.forEach((cb) => cb());
  }

  private common(): Extension[] {
    return [
      highlightSpecialChars(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      this.typingComp.of(typingHelpers(this.language, this.path)),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      languageExtension(this.language),
      syntaxHighlighting(highlight),
      editorTheme,
      EditorView.domEventHandlers({
        paste: (e, view) => this.onPaste(e, view),
        blur: () => { if (settings.get()?.autosave && this.dirty) void this.save(); return false; },
      }),
    ];
  }

  private sourceExtensions(): Extension[] {
    return [
      lineNumbers(),
      this.changeComp.of(changeGutter),
      highlightActiveLineGutter(),
      history(),
      foldGutter(),
      highlightActiveLine(),
      scrollPastEnd(),
      keymap.of([
        { key: "Mod-s", run: () => { void this.save(); return true; } },
        ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
      ]),
      ...this.common(),
      this.mergeComp.of([]),
      this.blameComp.of([]),
      changeField,
      changeRuler,
      EditorView.updateListener.of((u) => this.onUpdate(u, this.source)),
    ];
  }

  private richExtensions(): Extension[] {
    const ctx: PreviewContext = {
      resolve: (path, link) => this.resolve(path, link),
      exists: (target) => this.exists(target),
      // Only a web address leaves the application. Every other link goes
      // through `resolve`, which reads `file:` as a path and `asset:` or any
      // other scheme as outside, so none reaches the system opener.
      openLink: (href) => {
        if (/^(https?|mailto|tel):/i.test(href)) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(href)).catch((e) => this.hooks.notice(String(e)));
        else this.open(this.resolve(href, true), false);
      },
      citation: {
        exists: (path) => this.exists(this.resolve(path, false)),
        open: (path) => this.open(this.resolve(path, false), true),
        resolve: (path) => this.resolve(path, false),
      },
    };
    const source = this.source;
    const follow = () => {
      this.rich?.dispatch({ selection: source.state.selection, scrollIntoView: true, annotations: forwarded.of(true) });
      return true;
    };
    return [
      keymap.of([
        { key: "Mod-s", run: () => { void this.save(); return true; } },
        { key: "Mod-z", run: () => { undo(source); return follow(); } },
        { key: "Mod-y", run: () => { redo(source); return follow(); } },
        { key: "Mod-Shift-z", run: () => { redo(source); return follow(); } },
        ...defaultKeymap, ...searchKeymap, indentWithTab,
      ]),
      ...this.common(),
      // Before the preview: its shortcuts, pending formatting and Backspace at
      // a block's start come first, and every other key falls through.
      richFormatting(),
      livePreview(ctx),
      // Built later than the source view, it starts from the chunks the source already holds.
      changeField.init(() => this.source.state.field(changeField)),
      changeRuler,
      EditorView.updateListener.of((u) => this.onUpdate(u, this.rich!)),
    ];
  }

  private onUpdate(u: { docChanged: boolean; selectionSet: boolean; changes: import("@codemirror/state").ChangeSet; transactions: readonly import("@codemirror/state").Transaction[] }, origin: EditorView): void {
    if (this.disposed) return;
    const echo = u.transactions.some((tr) => tr.annotation(forwarded));
    // In rich mode the source view, which holds the only history, keeps the
    // rich view's caret, so an undo puts the caret back where the edit was. A
    // split's panes each keep their own.
    const caret = origin === this.rich && this.mode === "rich" ? origin.state.selection : undefined;
    if (u.docChanged && !echo) {
      const other = origin === this.source ? this.rich : this.source;
      // A rich-mode command is one entry in the source's history, never
      // joined with the typing beside it (RICH-18).
      const isolate = u.transactions.map((tr) => tr.annotation(isolateHistory)).find((v) => v);
      other?.dispatch({ changes: u.changes, selection: caret, annotations: isolate ? [forwarded.of(true), isolateHistory.of(isolate)] : forwarded.of(true) });
    } else if (caret && u.selectionSet && !echo) {
      this.source.dispatch({ selection: caret, annotations: forwarded.of(true) });
    }
    if (u.docChanged) {
      // A scroll kept for later names a place in the text, and an edit that
      // lands while the view is off screen — an agent's, through checkDisk —
      // moves that place.
      for (const kept of [this.owed, this.lastScroll]) {
        const at = kept.get(origin);
        if (!at) continue;
        const moved = at.map(u.changes);
        if (moved) kept.set(origin, moved);
        else kept.delete(origin);
      }
      const dirty = !this.source.state.doc.eq(this.saved);
      if (dirty !== this.dirty) this.dirty = dirty;
      const fromDisk = u.transactions.some((tr) => tr.annotation(external));
      if (dirty && !fromDisk) this.scheduleAutosave();
      this.scheduleDraft();
    }
    // The source view taking the rendered view's caret is news already told.
    if (u.docChanged || (u.selectionSet && !(echo && origin === this.source))) this.emit();
  }

  private ensureRich(): EditorView {
    if (!this.rich) {
      this.rich = new EditorView({
        state: EditorState.create({ doc: this.source.state.doc, extensions: this.richExtensions() }),
      });
    }
    return this.rich;
  }

  /** The view the user is working in. */
  active(): EditorView {
    if (this.mode === "rich" && this.rich) return this.rich;
    if (this.mode === "split" && this.rich?.hasFocus) return this.rich;
    return this.source;
  }

  mount(container: HTMLElement, initialLine: number, focus = true): void {
    if (!this.root) {
      this.root = document.createElement("div");
      this.root.className = "editor";
      this.layout();
      if (initialLine > 1 && !this.owed.size) {
        const view = this.active();
        const line = view.state.doc.line(Math.min(initialLine, view.state.doc.lines));
        this.owed.set(view, EditorView.scrollIntoView(line.from, { y: "start" }));
      }
    }
    // Focus moves to the document only when it is newly shown, and only when
    // the caller says so; a re-mount of what is already on screen must not
    // take it from an input elsewhere, and a preview opened by a click in the
    // file tree leaves the tree its keys.
    if (this.root.parentElement !== container) {
      // A tab moved to another group carries its scroll along.
      if (this.root.isConnected) this.rememberScroll();
      container.replaceChildren(this.root);
      for (const [view, at] of this.owed) view.dispatch({ effects: at });
      if (focus && !document.activeElement?.closest(".tree")) this.active().focus();
    }
    if (this.baseStale) void this.readBase();
  }

  focus(): void {
    this.active().focus();
  }

  /** Takes the document off `container`, unless it has moved on to another. */
  unmount(container: HTMLElement): void {
    if (!this.root || this.root.parentElement !== container) return;
    this.rememberScroll();
    this.root.remove();
  }

  /**
   * A detached scroller forgets its offset, so each view on screen records
   * where it is for the next mount to put back. The snapshot names a line,
   * not a pixel, so the document comes back at the same line in a group of
   * another width. It is read while still laid out: detached, or hidden, a
   * scroller reads 0, and a view hidden behind a panel gives where it last
   * was instead. A scroll still owed stands.
   */
  private rememberScroll(): void {
    const owed = new Map<EditorView, StateEffect<unknown>>();
    for (const view of [this.source, this.rich]) {
      if (!view || !this.root?.contains(view.dom)) continue;
      const at = this.owed.get(view) ?? (view.scrollDOM.clientHeight > 0 ? view.scrollSnapshot() : this.lastScroll.get(view));
      if (at) owed.set(view, at);
    }
    this.owed = owed;
  }

  private layout(): void {
    const root = this.root!;
    root.replaceChildren();
    root.dataset.mode = this.mode;
    if (this.mode === "source") {
      root.appendChild(this.source.dom);
    } else if (this.mode === "rich") {
      root.appendChild(this.ensureRich().dom);
    } else {
      const left = document.createElement("div");
      left.className = "editor-pane";
      const right = document.createElement("div");
      right.className = "editor-pane";
      left.appendChild(this.source.dom);
      right.appendChild(this.ensureRich().dom);
      root.append(left, right);
      this.source.scrollDOM.onscroll = () => this.syncScroll(this.source, this.rich!);
      this.rich!.scrollDOM.onscroll = () => this.syncScroll(this.rich!, this.source);
      // An image settles its height after the rest of the pane is laid out,
      // which moves every line below it. `load` does not bubble, so the
      // capture phase is what hears it (ED-06).
      this.rich!.dom.addEventListener("load", this.onMediaLoad, true);
      // Both panes have just been rebuilt; nothing has aligned them yet, and
      // a split that opens on two different parts of the document reads as
      // the sync being broken before a wheel is touched.
      requestAnimationFrame(() => {
        if (this.mode === "split" && this.rich) this.syncScroll(this.source, this.rich);
      });
    }
    if (this.mode !== "split") {
      this.source.scrollDOM.onscroll = null;
      if (this.rich) {
        this.rich.scrollDOM.onscroll = null;
        this.rich.dom.removeEventListener("load", this.onMediaLoad, true);
      }
    }
    // The last layout's pane may be gone, and its landing position with it.
    this.echoScroll = null;
    // One listener for the life of each view: `layout` runs again on every
    // mode change, and a fresh listener each time would pile up. A view
    // scrolled with a height is laid out: where it is now is where the reader
    // left it, and any scroll it owed has been paid.
    for (const view of [this.source, this.rich]) {
      if (!view || this.viewStateBound.has(view)) continue;
      this.viewStateBound.add(view);
      view.scrollDOM.addEventListener("scroll", () => {
        if (view.scrollDOM.clientHeight > 0) {
          this.lastScroll.set(view, view.scrollSnapshot());
          this.owed.delete(view);
        }
        this.scheduleViewState();
      });
    }
  }

  private readonly onMediaLoad = (): void => {
    if (this.mode === "split" && this.rich) this.syncScroll(this.source, this.rich);
  };

  /**
   * Holds the two panes of a split on the same line. Both views show the same
   * document, so a line is the anchor; what differs is how tall that line is
   * on each side, and a rendered image makes the difference enormous.
   *
   * The pane being scrolled names the line at its top edge and how far through
   * that line's block it has travelled, **as a fraction of the block**. The
   * other pane puts the same fraction of the same line under its own top edge.
   * Carrying the offset in pixels instead is what made a split with an image
   * in it feel stuck: twenty pixels into a source line is the whole line, and
   * the six hundred pixel image opposite it moved twenty pixels before jumping
   * the rest.
   */
  private syncScroll(from: EditorView, to: EditorView): void {
    // Writing `scrollTop` below fires the other pane's own scroll handler a
    // frame later. Clearing a flag in requestAnimationFrame clears it before
    // that event arrives — the echo then scrolls this pane back to where it
    // was a frame ago, and the pane fights the pointer. The write's landing
    // position is the reliable mark of its echo.
    if (this.echoScroll?.view === from && Math.abs(from.scrollDOM.scrollTop - this.echoScroll.top) <= 1) {
      this.echoScroll = null;
      return;
    }
    this.echoScroll = null;
    try {
      // A block's `top` is measured from the first line; `scrollTop` from the
      // top of the padding above it, and the two panes pad differently —
      // CodeMirror's own 4 px against the rendered pane's 16 px. The
      // conversion is made on each side, or every sync lands 12 px out.
      const height = Math.max(0, from.scrollDOM.scrollTop - from.documentPadding.top);
      const fromBlock = from.lineBlockAtHeight(height);
      const toBlock = to.lineBlockAt(fromBlock.from);
      const through = fromBlock.height > 0
        ? Math.min(1, Math.max(0, (height - fromBlock.top) / fromBlock.height))
        : 0;
      // `scrollPastEnd` gives each pane a screen of empty space after the last
      // line. Mapping the fraction through the last block would put that
      // empty space under the follower's top edge and show the reader
      // nothing; the end of one pane is the end of the other.
      const room = from.scrollDOM.scrollHeight - from.scrollDOM.clientHeight;
      const before = to.scrollDOM.scrollTop;
      to.scrollDOM.scrollTop = from.scrollDOM.scrollTop >= room - 1
        ? to.scrollDOM.scrollHeight - to.scrollDOM.clientHeight
        : to.documentPadding.top + toBlock.top + through * toBlock.height;
      const after = to.scrollDOM.scrollTop;
      // A write that changed nothing produces no echo to wait for.
      if (after !== before) this.echoScroll = { view: to, top: after };
    } catch {
      // A view mid-layout can refuse height queries; the next scroll retries.
    }
  }

  setMode(mode: Mode): void {
    if (!this.isMarkdown || mode === this.mode) return;
    const prev = this.active();
    const selection = prev.state.selection;
    this.mode = mode;
    if (this.root) this.layout();
    const next = this.active();
    if (next !== prev) {
      next.dispatch({ selection, scrollIntoView: true });
      next.focus();
    }
    this.scheduleViewState(true);
    this.emit();
  }

  cycleMode(): void {
    this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
  }

  topLine(): number {
    const view = this.active();
    try {
      const rect = view.scrollDOM.getBoundingClientRect();
      return view.state.doc.lineAt(view.posAtCoords({ x: rect.left + 4, y: rect.top + 2 }, false)).number;
    } catch {
      return 1;
    }
  }

  private scheduleViewState(now = false): void {
    if (this.viewTimer) window.clearTimeout(this.viewTimer);
    this.viewTimer = window.setTimeout(() => {
      this.viewTimer = null;
      if (!this.disposed) void api.setEditorView(this.workspaceId, this.id, this.mode, this.topLine()).catch(() => {});
    }, now ? 0 : 1500);
  }

  /** Keeps a copy of unsaved changes on disk so a crash loses nothing. */
  private scheduleDraft(): void {
    if (this.draftTimer) window.clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => {
      this.draftTimer = null;
      if (this.disposed) return;
      if (this.dirty) void api.saveDraft(this.workspaceId, this.path, this.source.state.doc.toString()).catch(() => {});
      else void api.deleteDraft(this.workspaceId, this.path).catch(() => {});
    }, 1500);
  }

  /** Deletes the draft, and any save of it still to come: the changes were discarded. */
  dropDraft(): void {
    if (this.draftTimer) window.clearTimeout(this.draftTimer);
    this.draftTimer = null;
    void api.deleteDraft(this.workspaceId, this.path).catch(() => {});
  }

  /** Applies a draft left by a previous run as unsaved changes. */
  restoreDraft(text: string): void {
    if (this.source.state.doc.toString() === text) return;
    this.source.dispatch({ changes: { from: 0, to: this.source.state.doc.length, insert: text } });
    this.restored = true;
    this.emit();
  }

  private scheduleAutosave(): void {
    const s = settings.get();
    if (!s?.autosave) return;
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => { this.autosaveTimer = null; void this.save(); }, s.autosaveDelayMs);
  }

  async save(): Promise<void> {
    const text = this.source.state.doc.toString();
    await api.writeFile(this.workspaceId, this.path, text);
    this.saved = this.source.state.doc;
    this.dirty = false;
    this.detached = false;
    this.conflict = null;
    this.restored = false;
    this.closeDiff();
    this.emit();
    void api.deleteDraft(this.workspaceId, this.path).catch(() => {});
  }

  /** Applies `text` as a change set so cursor and scroll survive. */
  private applyExternal(text: string): void {
    const current = this.source.state.doc.toString();
    const changes = diff(current, text).map((c) => ({ from: c.fromA, to: c.toA, insert: text.slice(c.fromB, c.toB) }));
    this.saved = Text.of(text.split("\n"));
    // A rewrite from outside is compared with the index afresh, by line: an
    // agent's edits can lie close enough together that re-diffing the stretch
    // around each by character gives up and marks everything between them.
    const effects = typeof this.base === "string" ? [setBase.of(this.base)] : [];
    this.source.dispatch({ changes, effects, annotations: external.of(true) });
    if (effects.length) this.rich?.dispatch({ effects });
  }

  /**
   * The file moved. The buffer, its unsaved changes and the cursor stay; what
   * was keyed by the old path — the file it saves to, its assets, the links
   * and citations resolved against its directory — follows it there.
   */
  relocate(path: string): void {
    if (path === this.path) return;
    this.path = path;
    const helpers = this.typingComp.reconfigure(typingHelpers(this.language, path));
    this.source.dispatch({ effects: helpers });
    this.rich?.dispatch({ effects: helpers });
    this.invalidateExistence();
    this.rich?.dispatch({ effects: refreshPreview.of(null) });
    this.refreshBase();
    // The watcher may have reported the old name's removal first.
    void this.checkDisk();
    this.emit();
  }

  /** The directory changed: compare the file on disk with what was last saved. */
  async checkDisk(): Promise<void> {
    if (this.disposed) return;
    let disk: string;
    try {
      disk = await api.readFile(this.workspaceId, this.path);
    } catch (e) {
      if (/No such file|not found|os error 2/i.test(String(e))) {
        if (!this.detached) { this.detached = true; this.emit(); }
      }
      return;
    }
    if (this.detached) { this.detached = false; this.emit(); }
    if (Text.of(disk.split("\n")).eq(this.saved)) return;
    if (!this.dirty) {
      this.applyExternal(disk);
      this.reloadedAt = Date.now();
      this.emit();
      // A later reload restarts the time; this timer then finds it not yet up.
      window.setTimeout(() => { if (Date.now() - this.reloadedAt >= NOTICE_DWELL_MS - 100) { this.reloadedAt = 0; this.emit(); } }, NOTICE_DWELL_MS);
    } else {
      this.conflict = disk;
      this.emit();
    }
  }

  keepMine(): void {
    if (this.conflict === null) return;
    this.saved = Text.of(this.conflict.split("\n"));
    this.conflict = null;
    this.dirty = !this.source.state.doc.eq(this.saved);
    this.closeDiff();
    this.emit();
  }

  takeTheirs(): void {
    if (this.conflict === null) return;
    const theirs = this.conflict;
    this.conflict = null;
    this.closeDiff();
    this.applyExternal(theirs);
    this.dirty = false;
    this.emit();
  }

  openDiff(): void {
    if (this.conflict === null) return;
    this.source.dispatch({
      effects: [
        this.mergeComp.reconfigure(unifiedMergeView({ original: this.conflict, mergeControls: true, highlightChanges: true })),
        this.changeComp.reconfigure([]),
      ],
    });
    this.diffOpen = true;
    if (this.mode === "rich") this.setMode("source");
    this.emit();
  }

  closeDiff(): void {
    if (!this.diffOpen) return;
    this.source.dispatch({ effects: [this.mergeComp.reconfigure([]), this.changeComp.reconfigure(changeGutter)] });
    this.diffOpen = false;
  }

  /**
   * The index may have moved (GIT-14). A document on screen reads it now; one
   * out of sight reads it when it is next shown, so a workspace out of sight
   * starts no git for its documents (ADR-018).
   */
  refreshBase(): void {
    this.baseStale = true;
    if (this.root?.isConnected) void this.readBase();
  }

  private async readBase(): Promise<void> {
    this.baseStale = false;
    const n = ++this.baseReads;
    // A buffer past the limit gets no marks, so its index copy is not fetched
    // only to be dropped, again after every git change an agent makes.
    // `./` names the file from the workspace, which may sit below the
    // repository's top level.
    const text = this.source.state.doc.length > MARKS_LIMIT
      ? null
      : await api.gitShowFile(this.workspaceId, ":", `./${this.path}`).catch(() => null);
    if (this.disposed || n !== this.baseReads || text === this.base) return;
    this.base = text;
    const effects = setBase.of(text);
    this.source.dispatch({ effects });
    this.rich?.dispatch({ effects });
  }

  /** Annotates every line with its last commit, or clears the annotations. */
  setBlame(lines: BlameLine[] | null): void {
    this.blameOn = lines !== null;
    const ext = lines
      ? gutter({
          class: "cm-blame-gutter",
          lineMarker: (view, line) => {
            const n = view.state.doc.lineAt(line.from).number;
            const info = lines[n - 1];
            return info ? new BlameMarker(info, () => { if (!/^0+$/.test(info.hash)) this.hooks.showCommit(info.hash); }) : null;
          },
          lineMarkerChange: () => false,
        })
      : [];
    this.source.dispatch({ effects: this.blameComp.reconfigure(ext) });
    if (lines && this.mode === "rich") this.setMode("source");
    this.emit();
  }

  /** Line and column of the main cursor, 1-based. */
  cursor(): { line: number; col: number } {
    const view = this.active();
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1 };
  }

  /** Every heading in the document, in order. */
  outline(): { level: number; text: string; from: number }[] {
    if (!this.isMarkdown) return [];
    const state = this.source.state;
    const out: { level: number; text: string; from: number }[] = [];
    syntaxTree(state).iterate({
      enter(n) {
        const m = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(n.name);
        if (!m) return n.name === "Document";
        const text = state.doc.sliceString(n.from, n.to).split("\n")[0].replace(/^#+\s*/, "").replace(/\s*#+$/, "").trim();
        out.push({ level: Number(m[1]), text, from: n.from });
        return false;
      },
    });
    return out;
  }

  /** Headings enclosing the cursor, outermost first. */
  headingTrail(): { text: string; from: number }[] {
    if (!this.isMarkdown) return [];
    const state = this.source.state;
    const head = this.active().state.selection.main.head;
    const trail: { level: number; text: string; from: number }[] = [];
    syntaxTree(state).iterate({
      to: head,
      enter(n) {
        const m = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(n.name);
        if (!m) return n.name === "Document";
        if (n.from > head) return false;
        const level = Number(m[1]);
        while (trail.length && trail[trail.length - 1].level >= level) trail.pop();
        const text = state.doc.sliceString(n.from, n.to).split("\n")[0].replace(/^#+\s*/, "").replace(/\s*#+$/, "").trim();
        trail.push({ level, text: `${"#".repeat(level)} ${text}`, from: n.from });
        return false;
      },
    });
    return trail;
  }

  jumpTo(pos: number): void {
    const view = this.active();
    const at = EditorView.scrollIntoView(pos, { y: "start", yMargin: 8 });
    view.dispatch({ selection: { anchor: pos }, effects: at });
    // A place asked for outranks where the document was left, and is owed
    // until the view is laid out to take it.
    this.owed = new Map([[view, at]]);
    view.focus();
  }

  jumpToLine(line: number, column = 0): void {
    const view = this.active();
    const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    this.jumpTo(Math.min(l.from + column, l.to));
  }

  // --- Paths ----------------------------------------------------------------

  /**
   * Where a path written in this document leads, in ADR-015's order: a file
   * inside the workspace, then one inside its worktree family, then — for a
   * path starting with `/` — the same path read from the workspace root.
   * Anything else is outside and is never requested. `link` reads a relative
   * path from the note's directory, as a Markdown link or image does; a
   * citation reads it from the root.
   */
  resolve(written: string, link: boolean): Resolved {
    if (link && /^(https?:|data:|blob:)/i.test(written)) return { written, file: null, rel: null, url: written, tip: "" };
    const outside = (abs: string | null): Resolved =>
      ({ written, file: null, rel: null, url: null, tip: abs ? `Outside the workspace: ${abs}` : "Outside the workspace" });
    let path = written;
    if (link) {
      path = path.split(/[?#]/)[0];
      try { path = decodeURI(path); } catch { /* A stray `%` belongs to the name. */ }
    }
    // A `file:` URL names an absolute path, never one read from the root.
    const fileUrl = /^file:\/\/(?:localhost)?(?=\/)/i.exec(path);
    if (fileUrl) path = path.slice(fileUrl[0].length);
    // A colon is legal in a file name, so only a link has a scheme.
    else if (link && /^[a-z][a-z\d+.-]*:/i.test(path)) return outside(null);
    const root = this.workspacePath;
    const absolute = path.startsWith("/");
    const base = absolute ? [] : [...root.split("/"), ...(link ? this.path.split("/").slice(0, -1) : [])];
    const parts = normalize([...base, ...path.split("/")]);
    const abs = parts && `/${parts.join("/")}`;
    const found = (file: string, rel: string | null): Resolved => ({ written, file, rel, url: convertFileSrc(file), tip: `Not found: ${file}` });
    if (abs && under(root, abs)) return found(abs, abs.slice(root.length + 1));
    const { reached, excluded } = family(this.hooks.workspaces().find((w) => w.id === this.workspaceId));
    // A sibling worktree is outside, not a path to try from the root.
    if (abs && excluded.some((d) => under(d, abs))) return outside(abs);
    if (abs && reached.some((d) => under(d, abs))) return found(abs, null);
    // The older `@/path` form, and GitHub's `/path`. Whether the file is there
    // is the load's answer: an absolute path elsewhere on disk reads the same.
    if (absolute && !fileUrl && parts) return found(`${root}/${parts.join("/")}`, parts.join("/"));
    return outside(abs);
  }

  /**
   * The session changed. When this workspace's worktree family did — its
   * repository summary arrives after launch, and worktrees come and go — the
   * rendered pane resolves its paths again.
   */
  refreshFamily(): void {
    const key = JSON.stringify(family(this.hooks.workspaces().find((w) => w.id === this.workspaceId)));
    if (this.disposed || key === this.familyKey) return;
    this.familyKey = key;
    this.rich?.dispatch({ effects: refreshPreview.of(null) });
  }

  /**
   * Opens a resolved file where it lives: here, or, for a file in the
   * worktree family, in the open workspace that holds it (CITE-17). A chip
   * turns the note permanent first (CITE-22a) and opens a permanent tab
   * (CITE-22). A link opens a preview tab, and turns the note permanent only
   * when that preview opens in this workspace, where it would take the note's
   * slot (CITE-22d). A chip for a folder shows it in the Explorer, one for a
   * file that is not there says so, and neither opens a tab (CITE-22c).
   */
  private open(target: Resolved, chip: boolean): void {
    const file = target.file;
    if (!file) return this.hooks.notice(`${target.written} is outside the workspace.`);
    const show = async (at: Home) => {
      const here = at.workspaceId === this.workspaceId;
      if (chip || here) await api.pinEditor(this.workspaceId, this.id);
      if (here) this.hooks.openFile(at.rel, !chip);
      else this.hooks.openIn(at.workspaceId, at.rel, !chip);
    };
    const failed = (e: unknown) => this.hooks.notice(String(e));
    if (!chip) {
      const at = this.home(target, file);
      if (at) show(at).catch(failed);
      return;
    }
    // Asked on the click rather than read from the drawing: the chip's answer
    // may not have landed, and a folder cited without its slash reads as a file.
    api.statEntries(this.workspaceId, [target.rel ?? file]).then(([entry]) => {
      if (!entry || entry.missing) return this.hooks.notice(`${target.written} does not exist`);
      const at = this.home(target, file);
      if (!at) return;
      if (entry.isDir) return this.hooks.reveal(at.workspaceId, at.rel);
      return show(at);
    }).catch(failed);
  }

  /** The open workspace a resolved file lives in and its path there, or null, said as a notice, when none holds it. */
  private home(target: Resolved, file: string): Home | null {
    if (target.rel !== null) return { workspaceId: this.workspaceId, rel: target.rel };
    const owner = this.hooks.workspaces()
      .filter((w) => w.id !== this.workspaceId && under(w.path, file))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (owner) return { workspaceId: owner.id, rel: file.slice(owner.path.length + 1) };
    this.hooks.notice(`${file} is in no open workspace.`);
    return null;
  }

  /**
   * Whether a resolved file exists, answered from a cache that is filled in
   * batches: known, or not yet (undefined). A web address counts as there; a
   * path outside the boundary is missing and never looked up.
   */
  private exists(target: Resolved): boolean | undefined {
    if (!target.file) return target.url !== null;
    // A family file goes by its absolute path, which `stat_entries` checks against the family.
    const key = target.rel ?? target.file;
    const known = this.existence.get(key);
    if (known === undefined) this.lookUp([key]);
    return known;
  }

  /** Stats the paths in one batch and redraws the rendered pane if an answer changed. */
  private lookUp(paths: string[]): void {
    paths.forEach((p) => this.pendingExists.add(p));
    if (this.existsTimer !== null) return;
    this.existsTimer = window.setTimeout(() => {
      this.existsTimer = null;
      const batch = [...this.pendingExists];
      this.pendingExists.clear();
      api.statEntries(this.workspaceId, batch).then((entries) => {
        if (this.disposed) return;
        let changed = false;
        for (const e of entries) {
          const exists = !e.missing;
          if (this.existence.get(e.path) !== exists) changed = true;
          this.existence.set(e.path, exists);
        }
        if (changed) this.rich?.dispatch({ effects: refreshPreview.of(null) });
      }).catch(() => {});
    }, 50);
  }

  /** The workspace changed on disk: every cited path is looked up again, keeping its last answer until the new one lands. */
  invalidateExistence(): void {
    if (this.existence.size > 0) this.lookUp([...this.existence.keys()]);
  }

  /**
   * Inserts `@path` at the caret, on its line, with one space before it when
   * the caret is not already after whitespace (CITE-01). Several paths go one
   * per line, in the order given (CITE-13).
   */
  insertCitation(path: string | string[]): void {
    const view = this.active();
    const pos = view.state.selection.main.head;
    const before = pos > view.state.doc.lineAt(pos).from ? view.state.doc.sliceString(pos - 1, pos) : "";
    const cited = (Array.isArray(path) ? path : [path]).map((p) => `@${p}`).join("\n");
    const insert = `${before && !/\s/.test(before) ? " " : ""}${cited}`;
    view.dispatch({ changes: { from: pos, to: view.state.selection.main.to, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true });
    view.focus();
  }

  /**
   * Writes a reference to each workspace path where it was dropped, at (x, y)
   * in whichever view is there (TREE-16): `@path` under the citation setting,
   * else a link from this note, as a pasted file is written. A folder's path
   * ends in `/`. Several go one per line, with a space before them when the
   * point is not after whitespace, as a citation's rule has it, and one after
   * them when the point is inside a word.
   */
  insertReference(paths: string[], x: number, y: number): void {
    const under = document.elementFromPoint(x, y)?.closest<HTMLElement>(".cm-editor");
    const found = under ? EditorView.findFromDOM(under) : null;
    const view = found && (found === this.source || found === this.rich) ? found : this.active();
    let pos = view.posAtCoords({ x, y }, false);
    const before = pos > view.state.doc.lineAt(pos).from ? view.state.doc.sliceString(pos - 1, pos) : "";
    const dir = this.path.includes("/") ? this.path.slice(0, this.path.lastIndexOf("/")) : "";
    paths.forEach((path, i) => {
      const gap = i > 0 ? "\n" : before && !/\s/.test(before) ? " " : "";
      if (gap) {
        view.dispatch({ changes: { from: pos, insert: gap } });
        pos += gap.length;
      }
      const folder = path.endsWith("/");
      const link = relativeLink(dir, path);
      const name = path.split("/").filter(Boolean).pop() ?? path;
      pos = this.insertLink(view, pos, { path, link: folder ? `${link || "."}/` : link, bytes: 0 }, name);
    });
    // A citation runs to the next whitespace.
    const after = view.state.doc.sliceString(pos, pos + 1);
    if (after && !/\s/.test(after)) view.dispatch({ changes: { from: pos, insert: " " }, selection: { anchor: pos } });
    view.focus();
  }

  // --- Assets ---------------------------------------------------------------

  private onPaste(e: ClipboardEvent, view: EditorView): boolean {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return false;
    e.preventDefault();
    void this.insertFiles(view, files, view.state.selection.main.head);
    return true;
  }

  private async insertFiles(view: EditorView, files: File[], at: number): Promise<void> {
    let pos = at;
    for (const file of files) {
      try {
        // Browsers name a raw clipboard bitmap `image.png`; that is no name at all.
        const name = file.name && !/^image\.(png|jpe?g|bmp|gif)$/i.test(file.name) ? file.name : null;
        const bytes = await file.arrayBuffer();
        const stored = await api.saveAsset(this.workspaceId, this.path, name, file.type || "application/octet-stream", bytes);
        pos = this.insertLink(view, pos, stored, name ?? stored.path.split("/").pop() ?? "asset");
        this.warnIfLarge(stored.bytes, stored.path);
      } catch (err) {
        this.hooks.notice(`Could not store ${file.name || "the pasted file"}: ${String(err)}`);
      }
    }
  }

  /** Files dropped from the file manager, as absolute paths, inserted at the caret. */
  async insertPaths(paths: string[]): Promise<void> {
    const view = this.active();
    let pos = view.state.selection.main.head;
    for (const source of paths) {
      try {
        const stored = await api.importAsset(this.workspaceId, this.path, source);
        pos = this.insertLink(view, pos, stored, source.split("/").pop() ?? "file");
        this.warnIfLarge(stored.bytes, stored.path);
      } catch (err) {
        this.hooks.notice(`Could not import ${source}: ${String(err)}`);
      }
    }
  }

  /** The stored asset as text: a note-relative markdown link, or a root-relative citation (CITE-03). */
  private insertLink(view: EditorView, pos: number, stored: StoredAsset, name: string): number {
    // A folder keeps its whole name, and a leading dot starts no extension.
    const label = stored.link.endsWith("/") ? name : name.replace(/(.)\.[^.]+$/, "$1");
    // A space would end the link. It is encoded here, once, so a pasted file,
    // one dropped from the file manager and one dragged from a tree agree.
    const link = stored.link.replace(/ /g, "%20");
    const kind = mediaKind(link);
    const insert = settings.get()?.assetLinks === "citation"
      ? `@${stored.path}`
      : kind === "file" ? `[${label}](${link})` : `![${label}](${link})`;
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
    return pos + insert.length;
  }

  private warnIfLarge(bytes: number, path: string): void {
    const limit = (settings.get()?.assetWarnMb ?? 5) * 1024 * 1024;
    if (bytes > limit) this.hooks.notice(`Stored a ${(bytes / 1024 / 1024).toFixed(1)} MB asset at ${path}.`);
  }

  dispose(): void {
    this.disposed = true;
    if (this.draftTimer) window.clearTimeout(this.draftTimer);
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
    if (this.viewTimer) window.clearTimeout(this.viewTimer);
    if (this.existsTimer) window.clearTimeout(this.existsTimer);
    this.rich?.destroy();
    this.source.destroy();
    this.root?.remove();
  }
}
