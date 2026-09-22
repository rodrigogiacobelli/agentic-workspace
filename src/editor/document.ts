// One open file: a source view that owns the document and its history, and a
// rendered view over the same document created on demand. See ADR-011.

import { Annotation, Compartment, EditorState, Text, type Extension } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { diff, unifiedMergeView } from "@codemirror/merge";
import { tags as t } from "@lezer/highlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../api";
import * as settings from "../settings";
import { languageExtension, type LanguageId } from "./languages";
import { livePreview, mediaKind, type PreviewContext } from "./preview";

export type Mode = "source" | "split" | "rich";
export const MODES: Mode[] = ["source", "split", "rich"];

/** A change that arrived from the other view; never forwarded back. */
const forwarded = Annotation.define<boolean>();
/** A change that came from disk rather than the user. */
export const external = Annotation.define<boolean>();

export interface DocHooks {
  /** Follow a link to a file inside the workspace. */
  openFile(relPath: string): void;
  notice(message: string): void;
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
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-matchingBracket": { backgroundColor: "var(--selection)", outline: "1px solid var(--accent)" },
  ".cm-searchMatch": { backgroundColor: "rgba(255, 200, 0, 0.25)" },
  ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-panel input, .cm-panel button": { color: "var(--fg)", background: "var(--bg)", border: "1px solid var(--border)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-hover)", color: "var(--fg-dim)", border: "none" },
});

function normalize(parts: string[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** Resolves a link written in `notePath` to a workspace-relative path. */
export function resolveLink(notePath: string, href: string): string {
  const dir = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
  const clean = decodeURI(href.split(/[?#]/)[0]);
  return normalize([...dir.split("/"), ...clean.split("/")]);
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
  private root: HTMLDivElement | null = null;
  private listeners = new Set<() => void>();
  private mergeComp = new Compartment();
  private autosaveTimer: number | null = null;
  private viewTimer: number | null = null;
  private syncingScroll = false;
  private disposed = false;

  constructor(
    readonly id: string,
    readonly workspaceId: string,
    readonly workspacePath: string,
    readonly path: string,
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
      rectangularSelection(),
      crosshairCursor(),
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
      highlightActiveLineGutter(),
      history(),
      foldGutter(),
      highlightActiveLine(),
      keymap.of([
        { key: "Mod-s", run: () => { void this.save(); return true; } },
        ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
      ]),
      ...this.common(),
      this.mergeComp.of([]),
      EditorView.updateListener.of((u) => this.onUpdate(u, this.source)),
    ];
  }

  private richExtensions(): Extension[] {
    const ctx: PreviewContext = {
      resolveUrl: (href) => {
        if (/^(https?:|data:|blob:)/i.test(href)) return href;
        return convertFileSrc(`${this.workspacePath}/${resolveLink(this.path, href)}`);
      },
      openLink: (href) => {
        if (/^[a-z]+:/i.test(href)) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(href)).catch((e) => this.hooks.notice(String(e)));
        else this.hooks.openFile(resolveLink(this.path, href));
      },
    };
    const source = this.source;
    const follow = () => {
      this.rich?.dispatch({ selection: source.state.selection, scrollIntoView: true });
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
      livePreview(ctx),
      EditorView.updateListener.of((u) => this.onUpdate(u, this.rich!)),
    ];
  }

  private onUpdate(u: { docChanged: boolean; selectionSet: boolean; changes: import("@codemirror/state").ChangeSet; transactions: readonly import("@codemirror/state").Transaction[] }, origin: EditorView): void {
    if (this.disposed) return;
    if (u.docChanged && !u.transactions.some((tr) => tr.annotation(forwarded))) {
      const other = origin === this.source ? this.rich : this.source;
      other?.dispatch({ changes: u.changes, annotations: forwarded.of(true) });
    }
    if (u.docChanged) {
      const dirty = !this.source.state.doc.eq(this.saved);
      if (dirty !== this.dirty) this.dirty = dirty;
      const fromDisk = u.transactions.some((tr) => tr.annotation(external));
      if (dirty && !fromDisk) this.scheduleAutosave();
    }
    if (u.docChanged || u.selectionSet) this.emit();
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

  mount(container: HTMLElement, initialLine: number): void {
    if (!this.root) {
      this.root = document.createElement("div");
      this.root.className = "editor";
      this.layout();
      if (initialLine > 1) {
        const view = this.active();
        const line = view.state.doc.line(Math.min(initialLine, view.state.doc.lines));
        view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "start" }) });
      }
    }
    if (this.root.parentElement !== container) container.replaceChildren(this.root);
    this.active().focus();
  }

  unmount(): void {
    this.root?.remove();
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
    }
    if (this.mode !== "split") {
      this.source.scrollDOM.onscroll = null;
      if (this.rich) this.rich.scrollDOM.onscroll = null;
    }
    const view = this.active();
    view.scrollDOM.addEventListener("scroll", () => this.scheduleViewState());
  }

  private syncScroll(from: EditorView, to: EditorView): void {
    if (this.syncingScroll) return;
    this.syncingScroll = true;
    try {
      const rect = from.scrollDOM.getBoundingClientRect();
      const pos = from.posAtCoords({ x: rect.left + 4, y: rect.top + 2 }, false);
      const block = to.lineBlockAt(to.state.doc.lineAt(pos).from);
      const fromBlock = from.lineBlockAt(from.state.doc.lineAt(pos).from);
      const offset = from.scrollDOM.scrollTop - fromBlock.top;
      to.scrollDOM.scrollTop = block.top + Math.min(offset, block.height);
    } catch {
      // A view mid-layout can refuse coordinate queries; the next scroll retries.
    }
    requestAnimationFrame(() => { this.syncingScroll = false; });
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
    this.closeDiff();
    this.emit();
  }

  /** Applies `text` as a change set so cursor and scroll survive. */
  private applyExternal(text: string): void {
    const current = this.source.state.doc.toString();
    const changes = diff(current, text).map((c) => ({ from: c.fromA, to: c.toA, insert: text.slice(c.fromB, c.toB) }));
    this.saved = Text.of(text.split("\n"));
    this.source.dispatch({ changes, annotations: external.of(true) });
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
      window.setTimeout(() => { if (Date.now() - this.reloadedAt >= 3900) { this.reloadedAt = 0; this.emit(); } }, 4000);
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
    this.source.dispatch({ effects: this.mergeComp.reconfigure(unifiedMergeView({ original: this.conflict, mergeControls: true, highlightChanges: true })) });
    this.diffOpen = true;
    if (this.mode === "rich") this.setMode("source");
    this.emit();
  }

  closeDiff(): void {
    if (!this.diffOpen) return;
    this.source.dispatch({ effects: this.mergeComp.reconfigure([]) });
    this.diffOpen = false;
  }

  /** Line and column of the main cursor, 1-based. */
  cursor(): { line: number; col: number } {
    const view = this.active();
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1 };
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
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 8 }) });
    view.focus();
  }

  jumpToLine(line: number, column = 0): void {
    const view = this.active();
    const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    this.jumpTo(Math.min(l.from + column, l.to));
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
        pos = this.insertLink(view, pos, stored.link, name ?? stored.path.split("/").pop() ?? "asset");
        this.warnIfLarge(stored.bytes, stored.path);
      } catch (err) {
        this.hooks.notice(`Could not store ${file.name || "the pasted file"}: ${String(err)}`);
      }
    }
  }

  /** Files dropped from the file manager, as absolute paths. */
  async insertPaths(paths: string[], coords: { x: number; y: number } | null): Promise<void> {
    const view = this.active();
    let pos = (coords && view.posAtCoords(coords)) ?? view.state.selection.main.head;
    for (const source of paths) {
      try {
        const stored = await api.importAsset(this.workspaceId, this.path, source);
        pos = this.insertLink(view, pos, stored.link, source.split("/").pop() ?? "file");
        this.warnIfLarge(stored.bytes, stored.path);
      } catch (err) {
        this.hooks.notice(`Could not import ${source}: ${String(err)}`);
      }
    }
  }

  private insertLink(view: EditorView, pos: number, link: string, name: string): number {
    const label = name.replace(/\.[^.]+$/, "");
    const kind = mediaKind(link);
    const text = kind === "file" ? `[${label}](${link})` : `![${label}](${link})`;
    const line = view.state.doc.lineAt(pos);
    const prefix = kind !== "file" && line.text.trim() !== "" ? "\n" : "";
    const insert = `${prefix}${text}`;
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
    return pos + insert.length;
  }

  private warnIfLarge(bytes: number, path: string): void {
    const limit = (settings.get()?.assetWarnMb ?? 5) * 1024 * 1024;
    if (bytes > limit) this.hooks.notice(`Stored a ${(bytes / 1024 / 1024).toFixed(1)} MB asset at ${path}.`);
  }

  dispose(): void {
    this.disposed = true;
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
    if (this.viewTimer) window.clearTimeout(this.viewTimer);
    this.rich?.destroy();
    this.source.destroy();
    this.root?.remove();
  }
}
