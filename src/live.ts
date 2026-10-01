// Whether a view is on screen, and what a view keeps once it is not. Only the
// workspace shown and its mode shown are mounted; everything else is rebuilt
// when it comes back (ADR-018). What the reader would notice missing —
// a typed message, a list already fetched, a scroll offset — is kept here,
// outside React, so a rebuilt view paints as it was left and re-reads after.
// A panel held behind another tab of its region stays mounted but idles: it
// marks itself stale when its data changes and reads it again once, when it
// is back.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type SetStateAction } from "react";
import { events } from "./api";

/** On screen: the workspace shown, the mode shown, the tab the one in front. */
export const Live = createContext(true);

export function useLive(): boolean {
  return useContext(Live);
}

/**
 * Calls `read` when git reports a change in the workspace — and, with `files`,
 * when a file in it changes — at once while the view is on screen, and once
 * when it comes back if something changed while it was away.
 */
export function useChanged(workspaceId: string, read: () => void, files = false): void {
  const live = useLive();
  const liveRef = useRef(live);
  liveRef.current = live;
  const latest = useRef(read);
  latest.current = read;
  const stale = useRef(false);
  useEffect(() => {
    const on = (id: string) => {
      if (id !== workspaceId) return;
      if (liveRef.current) latest.current();
      else stale.current = true;
    };
    const git = events.onGitChanged(on);
    const dirs = files ? events.onDirChanged((c) => on(c.workspaceId)) : null;
    return () => { void git.then((u) => u()); void dirs?.then((u) => u()); };
  }, [workspaceId, files]);
  useEffect(() => {
    if (live && stale.current) {
      stale.current = false;
      latest.current();
    }
  }, [live]);
}

/**
 * Keys name their owner: `<workspace id>:<what>` for a workspace's view, and
 * `<workspace id>:tab:<tab id>:<what>` for one tab's, so `retainKept` can
 * drop what a closed tab or a removed workspace left behind. One key belongs
 * to one mounted view at a time.
 */
const kept = new Map<string, unknown>();
/** The mounted views reading each key. */
const readers = new Map<string, Set<() => void>>();

function read(key: string, cb: () => void): () => void {
  const set = readers.get(key) ?? new Set();
  readers.set(key, set);
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0 && readers.get(key) === set) readers.delete(key);
  };
}

/**
 * `useState` whose value outlives the view: a rebuilt view starts from what
 * the last one held under the same key. The setter writes through at once
 * and redraws whichever view reads the key now, so a result landing after
 * the view that asked for it is gone — a fetch finishing, a push's output —
 * reaches the view built in its place.
 */
export function useKept<T>(key: string, initial: T): [T, (next: SetStateAction<T>) => void] {
  if (!kept.has(key)) kept.set(key, initial);
  const subscribe = useCallback((cb: () => void) => read(key, cb), [key]);
  // The same reader for the life of the key: handed a new one, React checks
  // the store again after every render, and a `keep` landing in between
  // redraws the view it was meant to leave alone.
  const snapshot = useCallback(() => kept.get(key) as T, [key]);
  const value = useSyncExternalStore(subscribe, snapshot);
  const set = useCallback((next: SetStateAction<T>) => {
    const prev = kept.get(key) as T;
    put(key, typeof next === "function" ? (next as (p: T) => T)(prev) : next);
  }, [key]);
  return [value, set];
}

/**
 * Writes a kept value from outside the views reading it, and redraws
 * whichever reads it now: what a request from elsewhere in the window
 * changes, such as the row a breadcrumb reveals in the Explorer.
 */
export function put<T>(key: string, value: T): void {
  if (Object.is(value, kept.get(key))) return;
  kept.set(key, value);
  readers.get(key)?.forEach((cb) => cb());
}

/**
 * Writes a kept value without redrawing its readers: for what a view records
 * as it goes, like an offset, and reads back with `peek` only when it is
 * rebuilt.
 */
export function keep<T>(key: string, value: T): void {
  kept.set(key, value);
}

/** Reads a kept value once, without following it: for what a view reads only when it is built. */
export function peek<T>(key: string): T | undefined {
  return kept.get(key) as T | undefined;
}

/**
 * A scroller's offset kept under `key`: recorded as it scrolls, and put back
 * when the view is rebuilt — once `ready` says the content it scrolls over
 * has rendered, since a list still empty has nowhere to scroll to.
 */
export function useKeptScroll<E extends HTMLElement>(key: string, ready = true): React.RefCallback<E> {
  const node = useRef<E | null>(null);
  /** The key whose offset has been put back; until then a scroll is the list still filling. */
  const restored = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = node.current;
    if (!el || !ready || restored.current === key) return;
    restored.current = key;
    const top = kept.get(key);
    if (typeof top === "number") el.scrollTop = top;
  });
  return useCallback((el: E | null) => {
    node.current = el;
    if (!el) return;
    const record = () => { if (restored.current === key) kept.set(key, el.scrollTop); };
    el.addEventListener("scroll", record, { passive: true });
    // The next element under the key — a list shown again after something else
    // stood in its place — is restored as well.
    return () => { el.removeEventListener("scroll", record); node.current = null; restored.current = null; };
  }, [key]);
}

/** Drops what removed workspaces and closed tabs left kept. */
export function retainKept(workspaceIds: Set<string>, tabIds: Set<string>): void {
  for (const key of [...kept.keys()]) {
    const [ws, kind, tab] = key.split(":");
    if (!workspaceIds.has(ws) || (kind === "tab" && !tabIds.has(tab))) kept.delete(key);
  }
}
