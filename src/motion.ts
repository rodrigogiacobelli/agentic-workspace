// The one piece of motion that cannot be CSS: a surface React would unmount
// before its exit had a frame to play. Everything else — the tokens, the
// easing, the reduced-motion switch — lives in `styles.css`.

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A duration token in milliseconds, read from the stylesheet rather than
 * restated here, so the reduced-motion override applies to JS timing too.
 */
export function duration(token: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const ms = raw.endsWith("ms") ? parseFloat(raw) : parseFloat(raw) * 1000;
  return Number.isFinite(ms) ? ms : 0;
}

/** An easing token's curve, for an animation run from script. */
export function easing(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

/**
 * Holds a dismissible surface open for its exit. Returns whether the exit is
 * playing — the caller puts `is-closing` on the element — and the dismiss to
 * call in place of `onClose`.
 *
 * A menu item that runs an action still closes instantly, as a platform menu
 * does: the action's own result is the acknowledgement, and a fade over it
 * reads as lag. This is for the paths where nothing else happens — Escape,
 * a click on the backdrop, the close button.
 */
export function useDismiss(onClose: () => void, token = "--d-exit"): [boolean, () => void, () => void] {
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | null>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  const stop = useCallback(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  // Dropped mid-exit — the parent removed the surface for its own reasons. The
  // close still has to land, or the state that was showing it stays set and
  // the surface comes back the next time that state is read.
  useEffect(() => () => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
    latest.current();
  }, []);
  const dismiss = useCallback(() => {
    if (timer.current !== null) return;
    setClosing(true);
    timer.current = window.setTimeout(onClose, duration(token));
  }, [onClose, token]);
  // A surface that is shown again while its exit is still playing has been
  // reused for something else. Without this the pending close would land on
  // whatever is now on screen: dismiss a context menu, right-click somewhere
  // else within the exit, and the new menu would vanish a moment later.
  const cancel = useCallback(() => { stop(); setClosing(false); }, [stop]);
  return [closing, dismiss, cancel];
}
