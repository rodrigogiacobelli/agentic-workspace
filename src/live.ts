// Whether a view is on screen. Every workspace shown once and both of its
// modes stay mounted (decision 6), so most mounted views are out of sight at
// any moment; they idle rather than merely hide. A view out of sight marks
// itself stale when its data changes and reads it again once, when it is back.

import { createContext, useContext, useEffect, useRef } from "react";
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
