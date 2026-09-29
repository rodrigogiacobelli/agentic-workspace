// Wheel scrolling is the application's own, everywhere a wheel scrolls
// vertically (standards-motion). WebKitGTK animates each wheel event by itself
// and starts over at the next, so the stream a high-resolution or free-spinning
// wheel sends moves a page in stalls and spurts. Here every event moves the
// scroller's target instead, and the scroller closes on it each frame by a
// fixed share of the distance left, so its speed follows the wheel's: it
// builds as the wheel spins up, holds while it spins, and falls away as it
// coasts. VSCodium's editor scrolls the same way.
//
// Sideways scrolling, a zoom (Ctrl), a terminal — xterm sends the wheel to the
// program running in it — and a desktop that asks for reduced motion keep the
// webview's own scrolling.

import { allowed, barTarget, room, scrollerAt } from "./scrollbars";

/** The share of the distance left that a scroller closes each frame. At 60
 * frames a second that is an ease with a time constant of about 90 ms: how far
 * behind the wheel a page runs. A step per frame rather than per millisecond,
 * because WebKitGTK's frame callbacks come at uneven times and a step scaled
 * by them moves the page unevenly between frames shown at even ones. */
const SHARE = 0.17;
/** What a wheel reporting lines moves per line; one reporting pages moves a screen. */
const LINE_PX = 40;

interface Glide {
  /** Where the wheel has sent the scroller. */
  target: number;
  /** Its position as eased here, kept fractional: the scroller rounds what it is given. */
  pos: number;
  /** What the scroller reported after the last write, to tell a move anything else made. */
  written: number;
}

const glides = new Map<HTMLElement, Glide>();
let frame = 0;
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

/** The scroller a vertical move of `dy` goes to from `node`: the nearest one with room left that way, as the webview chains a scroll outwards. */
function scrollerFor(node: Element | null, dy: number): HTMLElement | null {
  for (let el = barTarget(node) ?? scrollerAt(node, "y"); el; el = scrollerAt(el.parentElement, "y")) {
    if (!allowed(el)) return null;
    const at = glides.get(el)?.target ?? el.scrollTop;
    if (dy > 0 ? at < room(el, "y") - 0.5 : at > 0.5) return el;
  }
  return null;
}

function wheel(e: WheelEvent): void {
  if (e.defaultPrevented || e.ctrlKey || reduce.matches || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  const node = e.target instanceof Element ? e.target : null;
  if (!node || node.closest(".xterm")) return;
  const el = scrollerFor(node, e.deltaY);
  if (!el) return;
  const dy = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
  e.preventDefault();
  let glide = glides.get(el);
  if (!glide) {
    glide = { target: el.scrollTop, pos: el.scrollTop, written: el.scrollTop };
    glides.set(el, glide);
  }
  glide.target = Math.max(0, Math.min(room(el, "y"), glide.target + dy));
  if (!frame) frame = requestAnimationFrame(step);
}

function step(): void {
  frame = 0;
  for (const [el, glide] of glides) {
    if (!el.isConnected) {
      glides.delete(el);
      continue;
    }
    // Anything else that moved the scroller since the last frame — an editor
    // keeping its place as it measures the lines coming into view, a split's
    // other pane following — moves the target too, rather than being undone.
    const moved = el.scrollTop - glide.written;
    glide.pos += moved;
    glide.target = Math.max(0, Math.min(room(el, "y"), glide.target + moved));
    const left = glide.target - glide.pos;
    if (Math.abs(left) < 0.5) {
      el.scrollTop = glide.target;
      glides.delete(el);
      continue;
    }
    glide.pos += left * SHARE;
    el.scrollTop = glide.pos;
    glide.written = el.scrollTop;
  }
  if (glides.size) frame = requestAnimationFrame(step);
}

/** A press or a key stops every glide where it is, as a touch stops a fling; the scrollbar, a jump or the caret then move the page. */
function stop(): void {
  glides.clear();
  cancelAnimationFrame(frame);
  frame = 0;
}

export function installWheel(): void {
  // Listened for last, as the event bubbles out of the window: a surface that
  // scrolls the wheel its own way — a tab strip sideways, a terminal — has had
  // it first.
  window.addEventListener("wheel", wheel, { passive: false });
  window.addEventListener("pointerdown", stop, true);
  window.addEventListener("keydown", stop, true);
}
