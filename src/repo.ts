// The repository state of each workspace — git's summary, the status list and
// the stashes — kept outside React, like the editor and terminal registries,
// so the Commit panel, the Explorer's decorations and the status bar read one
// copy of it, and a panel rebuilt when its workspace comes back paints from it
// at once. The watcher's events refresh the workspace on screen; one in the
// background is only marked stale, and is read again when it is shown. A
// refresh tells only that workspace's readers, and only when a read changed
// something.

import { useCallback, useSyncExternalStore } from "react";
import { api, events } from "./api";
import type { RepoInfo, Stash, StatusEntry } from "./types";

export interface Repo {
  /** Null until the first read lands. */
  info: RepoInfo | null;
  status: StatusEntry[];
  stashes: Stash[];
}

const EMPTY: Repo = { info: null, status: [], stashes: [] };
const NOT_A_REPO: RepoInfo = { isRepo: false, branch: null, detached: false, state: null, isWorktree: false, mainWorktree: null, upstream: null, ahead: 0, behind: 0 };

const repos = new Map<string, Repo>();
const stale = new Set<string>();
/** A re-read waiting out its delay, and whether it reads everything or only the status. */
const waiting = new Map<string, boolean>();
/**
 * The latest read asked for per workspace — `all` of everything, `status` of
 * the status list, which every read takes — so an older one landing late is
 * dropped for whatever a newer one reads.
 */
const reads = new Map<string, { all: number; status: number }>();
let asked = 0;
const listeners = new Map<string, Set<() => void>>();
let active: string | null = null;
let listening = false;

export function get(workspaceId: string): Repo {
  return repos.get(workspaceId) ?? EMPTY;
}

function subscribe(workspaceId: string, cb: () => void): () => void {
  const set = listeners.get(workspaceId) ?? new Set();
  listeners.set(workspaceId, set);
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0 && listeners.get(workspaceId) === set) listeners.delete(workspaceId);
  };
}

/** The earlier copy when a read brought back the same thing, so a list keeps its identity and its readers skip the work. */
function same<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

/** Stores what a read brought back, and tells the workspace's readers only if it changed anything. */
function store(workspaceId: string, next: Partial<Repo>): void {
  const prev = get(workspaceId);
  const merged: Repo = {
    info: next.info === undefined ? prev.info : same(prev.info, next.info),
    status: next.status === undefined ? prev.status : same(prev.status, next.status),
    stashes: next.stashes === undefined ? prev.stashes : same(prev.stashes, next.stashes),
  };
  if (merged.info === prev.info && merged.status === prev.status && merged.stashes === prev.stashes) return;
  repos.set(workspaceId, merged);
  listeners.get(workspaceId)?.forEach((cb) => cb());
}

/**
 * Reads the workspace's repository again, now: all of it, or the status list
 * alone. The status alone is not enough where no repository is held — a `git
 * init` there reaches the watcher only as a change to the root — nor where git
 * refuses the status, as it does once `.git` has gone.
 */
async function read(workspaceId: string, all: boolean): Promise<void> {
  if (get(workspaceId).info?.isRepo !== true) all = true;
  const n = ++asked;
  const last = reads.get(workspaceId) ?? { all: 0, status: 0 };
  reads.set(workspaceId, { all: all ? n : last.all, status: n });
  if (!all) {
    const status = await api.gitStatus(workspaceId).catch(() => null);
    if (reads.get(workspaceId)?.status !== n) return;
    if (status) store(workspaceId, { status });
    else await read(workspaceId, true);
    return;
  }
  const info = await api.gitInfo(workspaceId).catch(() => NOT_A_REPO);
  const [status, stashes] = info.isRepo
    ? await Promise.all([api.gitStatus(workspaceId).catch(() => []), api.gitStashes(workspaceId).catch(() => [])])
    : [[], []];
  const latest = reads.get(workspaceId);
  if (latest?.all !== n) return;
  stale.delete(workspaceId);
  store(workspaceId, latest.status === n ? { info, status, stashes } : { info, stashes });
}

/** Reads the workspace's repository again, now. */
export function refresh(workspaceId: string): Promise<void> {
  return read(workspaceId, true);
}

/**
 * A change reported for a workspace: the one on screen re-reads 300 ms after
 * the first. A file changing moves only the status list; the summary and the
 * stashes change through the git directory, which reports itself.
 */
function changed(workspaceId: string, all: boolean): void {
  if (workspaceId !== active) {
    stale.add(workspaceId);
    return;
  }
  // A read already waiting takes this change too. Pushing it back instead
  // would starve it while changes keep arriving, and an agent at work in the
  // terminal keeps them arriving.
  const pending = waiting.get(workspaceId);
  waiting.set(workspaceId, all || pending === true);
  if (pending !== undefined) return;
  window.setTimeout(() => {
    const everything = waiting.get(workspaceId) === true;
    waiting.delete(workspaceId);
    void read(workspaceId, everything);
  }, 300);
}

/**
 * Names the workspace on screen. It follows the watcher from now on; one that
 * went stale while it was in the background is read again first.
 */
export function show(workspaceId: string | null): void {
  if (!listening) {
    listening = true;
    void events.onDirChanged((c) => changed(c.workspaceId, false));
    void events.onGitChanged((id) => changed(id, true));
  }
  active = workspaceId;
  if (workspaceId && (stale.has(workspaceId) || !repos.has(workspaceId))) void refresh(workspaceId);
}

/** Files with work-tree changes or not yet tracked; what is only staged does not count (FIX-06). */
export function unstagedCount(status: StatusEntry[]): number {
  return status.filter((s) => s.untracked || s.conflicted || s.worktree !== ".").length;
}

export function useRepo(workspaceId: string): Repo {
  const sub = useCallback((cb: () => void) => subscribe(workspaceId, cb), [workspaceId]);
  return useSyncExternalStore(sub, () => get(workspaceId));
}
