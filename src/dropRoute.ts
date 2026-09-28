// Where a drag inside the Workspace window lands. WebKitGTK drops only where
// the last dragover was accepted, and a drag carrying a file's URI — a tree
// row's, so another application can take the file (TREE-15) — hides every
// custom type from the targets, and has its drop taken by wry and reported as
// Tauri's native drop, after `dragend` and `dragleave` have reached the page.
// So a target reads a tree drag from here, never from its data, and in its
// dragover offers what a drop there would do, decided then. The drop — a DOM
// `drop`, or the native one of a drag begun in this page — runs the offer of
// the last dragover and nothing else.

import type { DragEvent as ReactDragEvent } from "react";
import { api } from "./api";

/** Rows dragged out of a tree, recorded as the drag starts. */
export interface TreeDrag {
  workspaceId: string;
  /** Workspace-relative, in tree order. */
  paths: string[];
  /** The same entries as absolute paths, which the file operations take. */
  abs: string[];
  /** Those of `paths` that are folders. */
  dirs: Set<string>;
  /** The view whose root entries these all are: dropped on another of them, they reorder it (VIEW-12). */
  roots: string | null;
  /** One of them is a view entry whose file is gone: the drag can only reorder its view. */
  missing: boolean;
  /** It carries its file's URI for other applications (TREE-15), and with it a native session of its own. */
  uri: boolean;
}

/** What a drop does, decided in the dragover that offered it. `copy` is whether Ctrl was down as it landed (TREE-11). */
export type DropAction = (how: { copy: boolean }) => void;

let tree: TreeDrag | null = null;
/** A drag begun in this page is under way, from its `dragstart` to its `dragend`. */
let domDragLive = false;
/**
 * When the last tree drag ended before Tauri saw it: released within the
 * moment its native session takes to start, its `enter` reaches the page
 * after its `dragend`.
 */
let treeEnded = -Infinity;
/** Whether Tauri has seen the drag under way since the drag last came over the page. */
let sighted = false;
let offer: { event: Event; run: DropAction } | null = null;
/** Whether the native session under way began in this page; null between sessions. */
let native: boolean | null = null;
const ends = new Set<() => void>();

export function startTreeDrag(drag: TreeDrag): void {
  tree = drag;
}

/** The tree drag under way, when the drag under way is one. */
export function treeDrag(): TreeDrag | null {
  return tree;
}

/** The first file a tree drag holds: what a drop that opens a file opens (ED-41). */
export function firstFile(drag: TreeDrag): string | undefined {
  return drag.paths.find((p) => !drag.dirs.has(p));
}

/**
 * Accepts the drag here and offers what a drop would do. The first offer in
 * an event wins — a row's over the tree around it — and the next dragover
 * starts afresh. Returns whether this one won.
 */
export function offerDrop(e: ReactDragEvent, run: DropAction): boolean {
  if (offer?.event === e.nativeEvent) return false;
  offer = { event: e.nativeEvent, run };
  e.preventDefault();
  // Under X11 a drop effect outside what the source allows cancels the drop,
  // and Ctrl there allows only a copy.
  e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === "copy" ? "copy" : "move";
  return true;
}

/**
 * Runs the last dragover's offer, once, with Ctrl as GDK saw it at the drop
 * captured as Tauri took it for a `native` drop, read now for a DOM one.
 */
export async function takeDrop(native: boolean): Promise<void> {
  const taken = offer;
  offer = null;
  if (!taken) return;
  const { ctrl } = await api.dropModifiers(native).catch(() => ({ ctrl: false }));
  taken.run({ copy: ctrl });
}

/** Calls `cb` whenever a drag finishes, dropped or not: every target clears its marks there. Returns the unsubscribe. */
export function onDropEnd(cb: () => void): () => void {
  ends.add(cb);
  return () => { ends.delete(cb); };
}

function finish(): void {
  ends.forEach((cb) => cb());
}

/**
 * Follows Tauri's drag session and says where it began. An `enter` arriving
 * while a drag of this page is under way, or just after a tree drag ended
 * unseen, is this page's own: its drop runs the offer and is never an import
 * of the dragged file. Any other came from another application.
 */
export function nativeSession(type: "enter" | "over" | "drop" | "leave"): "in-page" | "external" {
  if (type === "enter" || native === null) {
    native = domDragLive || performance.now() - treeEnded < 1500;
    if (domDragLive) sighted = true;
    // The late session is the ended drag's one; the next is someone else's.
    else treeEnded = -Infinity;
  }
  const inPage = native;
  if (type === "leave" || type === "drop") {
    native = null;
    // Out of the window, the drag offers again only through a new dragover.
    if (type === "leave") offer = null;
    finish();
  }
  return inPage ? "in-page" : "external";
}

/** Installs the router on this window's document; returns its removal. */
export function installDropRoute(): () => void {
  const ended = () => {
    if (!domDragLive) return;
    domDragLive = false;
    // Only a drag that has a session of its own, not yet seen, can be followed
    // by it. Any other leaves no window in which another application's drag
    // would be taken for this one.
    if (tree?.uri && !sighted) treeEnded = performance.now();
    tree = null;
    finish();
  };
  const started = (e: DragEvent) => {
    domDragLive = true;
    sighted = false;
    tree = null;
    offer = null;
    // A source taken out of the document mid-drag still hears its own dragend.
    e.target?.addEventListener("dragend", ended, { once: true });
  };
  // A dragover with no native session under way — before Tauri's first
  // `enter`, or back over the page after its `leave` — has one Tauri has not
  // seen yet.
  const over = () => {
    offer = null;
    if (native === null) sighted = false;
  };
  // A drag without a file's URI — a multi-selection — ends in a DOM drop,
  // where the last dragover accepted it.
  const dropped = (e: DragEvent) => {
    if (offer) {
      e.preventDefault();
      void takeDrop(false);
    }
    finish();
  };
  document.addEventListener("dragstart", started, true);
  document.addEventListener("dragend", ended, true);
  document.addEventListener("dragover", over, true);
  document.addEventListener("drop", dropped, true);
  return () => {
    document.removeEventListener("dragstart", started, true);
    document.removeEventListener("dragend", ended, true);
    document.removeEventListener("dragover", over, true);
    document.removeEventListener("drop", dropped, true);
  };
}
