// The repository state of each workspace — git's summary, the status list and
// the stashes — kept outside React, like the editor and terminal registries,
// so the Commit panel, the Explorer's decorations and the status bar read one
// copy of it. The watcher's events refresh the workspace on screen; one in the
// background is only marked stale, and is read again when it is shown.

import { useEffect, useState } from "react";
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
const timers = new Map<string, number>();
/** The latest read asked for per workspace, so an older one landing late is dropped. */
const reads = new Map<string, number>();
const listeners = new Set<() => void>();
let active: string | null = null;
let listening = false;

export function get(workspaceId: string): Repo {
  return repos.get(workspaceId) ?? EMPTY;
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reads the workspace's repository again, now. */
export async function refresh(workspaceId: string): Promise<void> {
  const read = (reads.get(workspaceId) ?? 0) + 1;
  reads.set(workspaceId, read);
  const info = await api.gitInfo(workspaceId).catch(() => NOT_A_REPO);
  const [status, stashes] = info.isRepo
    ? await Promise.all([api.gitStatus(workspaceId).catch(() => []), api.gitStashes(workspaceId).catch(() => [])])
    : [[], []];
  if (reads.get(workspaceId) !== read) return;
  repos.set(workspaceId, { info, status, stashes });
  stale.delete(workspaceId);
  listeners.forEach((cb) => cb());
}

/** A change reported for a workspace: the one on screen re-reads 300 ms after the first. */
function changed(workspaceId: string): void {
  if (workspaceId !== active) {
    stale.add(workspaceId);
    return;
  }
  // A read already waiting takes this change too. Pushing it back instead
  // would starve it while changes keep arriving, and an agent at work in the
  // terminal keeps them arriving.
  if (timers.has(workspaceId)) return;
  timers.set(workspaceId, window.setTimeout(() => {
    timers.delete(workspaceId);
    void refresh(workspaceId);
  }, 300));
}

/**
 * Names the workspace on screen. It follows the watcher from now on; one that
 * went stale while it was in the background is read again first.
 */
export function show(workspaceId: string | null): void {
  if (!listening) {
    listening = true;
    void events.onDirChanged((c) => changed(c.workspaceId));
    void events.onGitChanged(changed);
  }
  active = workspaceId;
  if (workspaceId && (stale.has(workspaceId) || !repos.has(workspaceId))) void refresh(workspaceId);
}

/** Files with work-tree changes or not yet tracked; what is only staged does not count (FIX-06). */
export function unstagedCount(status: StatusEntry[]): number {
  return status.filter((s) => s.untracked || s.conflicted || s.worktree !== ".").length;
}

export function useRepo(workspaceId: string): Repo {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((n) => n + 1)), []);
  return get(workspaceId);
}
