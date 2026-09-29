// Tooltips drawn by the app. The platform's own take half a second to show
// and cannot be tuned; these take their text from the element's `title` and
// follow the pointer at once while one is on screen.

import { duration } from "./motion";

/** Hover intent: long enough that a cursor crossing an icon does not open one
 *  (§7). Once one is up the next has none, which is the rest of that rule. */
const delay = () => duration("--delay-hover-in") || 350;

/**
 * Puts a shown, fixed layer under `anchor` at its left edge, or above it when
 * there is no room below, and inside the window either way.
 */
export function place(layer: HTMLElement, anchor: Element): void {
  // Measured from the window's corner, with the whole width free to it: where
  // it last stood could have wrapped it narrower than it will be.
  layer.style.left = layer.style.top = "0px";
  const r = anchor.getBoundingClientRect();
  const w = layer.offsetWidth;
  const h = layer.offsetHeight;
  const below = r.bottom + 6;
  layer.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
  layer.style.top = `${below + h > window.innerHeight ? Math.max(4, r.top - h - 6) : below}px`;
}

export function installTooltips(): void {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  document.body.appendChild(tip);
  /** The element whose tip is shown or pending. */
  let current: Element | null = null;
  /** The element under the last click: no tip for it until the pointer leaves. */
  let clicked: Element | null = null;
  let timer: number | null = null;

  const hoverable = (node: EventTarget | null): Element | null =>
    (node as Element | null)?.closest?.("[title], [data-tip]") ?? null;

  const hide = () => {
    if (timer) { window.clearTimeout(timer); timer = null; }
    tip.hidden = true;
    current = null;
  };
  const show = (el: Element, text: string) => {
    if (!el.isConnected) return;
    tip.textContent = text;
    tip.hidden = false;
    place(tip, el);
  };

  document.addEventListener("mouseover", (e) => {
    // A pointer crossing things with a button held is dragging: a tab, a
    // selection, a divider.
    if (e.buttons) return;
    const el = hoverable(e.target);
    if (el === current || el === clicked) return;
    clicked = null;
    // A tip already on screen moves to the next element without the delay.
    const chain = !tip.hidden;
    hide();
    if (!el) return;
    // The native tooltip would show too; the text moves to a data attribute.
    const title = el.getAttribute("title");
    if (title) { el.setAttribute("data-tip", title); el.removeAttribute("title"); }
    const text = el.getAttribute("data-tip");
    if (!text) return;
    current = el;
    if (chain) show(el, text);
    else timer = window.setTimeout(() => { timer = null; if (current === el) show(el, text); }, delay());
  });
  document.addEventListener("mouseout", (e) => {
    if (!current) return;
    const to = e.relatedTarget as Node | null;
    if (to && current.contains(to)) return;
    // Straight onto another element with a tip: the mouseover that follows
    // decides, with this tip still up. Anywhere else, the delay starts over.
    if (hoverable(to)) return;
    hide();
  });
  document.addEventListener("mousedown", (e) => { clicked = hoverable(e.target); hide(); }, true);
  for (const type of ["keydown", "wheel", "dragstart"]) document.addEventListener(type, hide, true);
  window.addEventListener("blur", hide);
}
