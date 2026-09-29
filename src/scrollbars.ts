// The one place that draws a scrollbar.
//
// WebKitGTK paints its native overlay bar above every layer, whatever the
// stacking order says, and ignores the size a stylesheet asks for: the bar of
// whatever sits under a menu is drawn across the menu's face, and the tab
// strip's bar is drawn across the tabs instead of beside them. Native bars are
// switched off in styles.css; these are drawn over the scroller's trailing
// edge, take no layout space, and belong to one surface at a time — so a
// dialog never shows the bar of the editor behind it (SCR-01 to SCR-07).

type Axis = "x" | "y";

const AXES: Axis[] = ["y", "x"];
/** Short enough to grab on a four-thousand-line file. */
const MIN_THUMB = 20;
const HIDE_MS = 1400;
/** How near the trailing edge the pointer reveals the bar. */
const REVEAL_PX = 16;

interface Rail {
  thumb: HTMLDivElement;
  /** Vertical only: the lane behind the thumb, which pages when clicked. A
   * horizontal lane would sit across the tabs, which is the fault this
   * replaces, so the horizontal axis has a thumb and nothing else. */
  track: HTMLDivElement | null;
  target: HTMLElement | null;
  hide: number;
}

const rails = {} as Record<Axis, Rail>;
let dragging: Axis | null = null;
let queued = false;
let ticking = false;

export function room(el: HTMLElement, axis: Axis): number {
  return axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
}

export function scrolls(el: HTMLElement, axis: Axis): boolean {
  if (room(el, axis) <= 1) return false;
  const style = getComputedStyle(el);
  const value = axis === "y" ? style.overflowY : style.overflowX;
  return value === "auto" || value === "scroll";
}

/** The nearest ancestor of `node` that scrolls on `axis`. */
export function scrollerAt(node: Element | null, axis: Axis): HTMLElement | null {
  for (let el = node as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    if (el.classList.contains("sbar-thumb") || el.classList.contains("sbar-track")) continue;
    if (scrolls(el, axis)) return el;
  }
  return null;
}

/** While a menu or a dialog is open, only what is inside one gets a bar. */
export function allowed(el: HTMLElement): boolean {
  const layers = document.querySelectorAll(".menu, .overlay");
  if (layers.length === 0) return true;
  for (const layer of layers) if (layer.contains(el)) return true;
  return false;
}

function place(axis: Axis): void {
  const rail = rails[axis];
  const el = rail.target;
  if (!el || !el.isConnected || room(el, axis) <= 1) return hide(axis);
  const box = el.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return hide(axis);
  const lane = axis === "y" ? box.height : box.width;
  const shown = axis === "y" ? el.clientHeight : el.clientWidth;
  const whole = axis === "y" ? el.scrollHeight : el.scrollWidth;
  const length = Math.max(MIN_THUMB, Math.round((shown / whole) * lane));
  const at = axis === "y" ? el.scrollTop : el.scrollLeft;
  const offset = Math.round((at / room(el, axis)) * Math.max(0, lane - length));
  const thumb = rail.thumb.style;
  if (axis === "y") {
    const x = Math.round(box.right) - 8;
    thumb.left = `${x}px`;
    thumb.top = `${Math.round(box.top) + offset}px`;
    thumb.width = "6px";
    thumb.height = `${length}px`;
    const track = rail.track!.style;
    track.left = `${x}px`;
    track.top = `${Math.round(box.top)}px`;
    track.width = "6px";
    track.height = `${Math.round(box.height)}px`;
  } else {
    thumb.left = `${Math.round(box.left) + offset}px`;
    thumb.top = `${Math.round(box.bottom) - 4}px`;
    thumb.width = `${length}px`;
    thumb.height = "3px";
  }
}

/** The scroller a vertical bar stands for, when `node` is that bar's thumb or lane. */
export function barTarget(node: Element | null): HTMLElement | null {
  const bar = node?.closest?.(".sbar-thumb.sbar-y, .sbar-track");
  return bar ? rails.y?.target ?? null : null;
}

function hide(axis: Axis): void {
  if (dragging === axis) return;
  rails[axis].thumb.classList.remove("on");
  rails[axis].track?.classList.remove("on");
}

function show(axis: Axis, el: HTMLElement): void {
  const rail = rails[axis];
  rail.target = el;
  place(axis);
  if (room(el, axis) <= 1) return;
  rail.thumb.classList.add("on");
  rail.track?.classList.add("on");
  window.clearTimeout(rail.hide);
  rail.hide = window.setTimeout(() => hide(axis), HIDE_MS);
  pump();
}

/** A visible bar is re-checked every frame: its surface can be resized, taken
 * off screen, or covered by a menu that opened after the bar was drawn, and a
 * bar left over any of those is the fault this module exists to remove. */
function pump(): void {
  if (ticking) return;
  ticking = true;
  const step = () => {
    let live = false;
    for (const axis of AXES) {
      if (!rails[axis].thumb.classList.contains("on")) continue;
      const el = rails[axis].target;
      if (!el || !el.isConnected || !allowed(el)) {
        hide(axis);
        continue;
      }
      place(axis);
      live = true;
    }
    if (live) requestAnimationFrame(step);
    else ticking = false;
  };
  requestAnimationFrame(step);
}

function drag(axis: Axis, event: PointerEvent): void {
  const rail = rails[axis];
  const el = rail.target;
  if (!el) return;
  event.preventDefault();
  rail.thumb.setPointerCapture(event.pointerId);
  rail.thumb.classList.add("dragging");
  dragging = axis;
  const box = el.getBoundingClientRect();
  const free = (axis === "y" ? box.height : box.width) - (axis === "y" ? rail.thumb.offsetHeight : rail.thumb.offsetWidth);
  const reach = room(el, axis);
  const from = axis === "y" ? event.clientY : event.clientX;
  const start = axis === "y" ? el.scrollTop : el.scrollLeft;
  const move = (e: PointerEvent) => {
    const moved = (axis === "y" ? e.clientY : e.clientX) - from;
    const next = free > 0 ? start + (moved / free) * reach : start;
    if (axis === "y") el.scrollTop = next;
    else el.scrollLeft = next;
    place(axis);
  };
  const up = () => {
    dragging = null;
    rail.thumb.classList.remove("dragging");
    rail.thumb.removeEventListener("pointermove", move);
    rail.thumb.removeEventListener("pointerup", up);
    rail.thumb.removeEventListener("pointercancel", up);
    show(axis, el);
  };
  rail.thumb.addEventListener("pointermove", move);
  rail.thumb.addEventListener("pointerup", up);
  rail.thumb.addEventListener("pointercancel", up);
}

/** The pointer near a scroller's trailing edge reveals that scroller's bar. */
function onPointer(event: PointerEvent): void {
  if (dragging || queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const node = event.target as Element | null;
    if (node instanceof HTMLElement && (node.classList.contains("sbar-thumb") || node.classList.contains("sbar-track"))) {
      for (const axis of AXES) if (rails[axis].thumb.classList.contains("on")) show(axis, rails[axis].target!);
      return;
    }
    for (const axis of AXES) {
      const el = scrollerAt(node, axis);
      if (!el || !allowed(el)) continue;
      const box = el.getBoundingClientRect();
      const edge = axis === "y" ? box.right - event.clientX : box.bottom - event.clientY;
      if (edge >= 0 && edge <= REVEAL_PX) show(axis, el);
    }
  });
}

export function installScrollbars(): void {
  const layer = document.createElement("div");
  layer.className = "sbars";
  for (const axis of AXES) {
    const thumb = document.createElement("div");
    thumb.className = `sbar-thumb sbar-${axis}`;
    const track = axis === "y" ? document.createElement("div") : null;
    rails[axis] = { thumb, track, target: null, hide: 0 };
    if (track) {
      track.className = "sbar-track";
      track.addEventListener("pointerdown", (e) => {
        const el = rails.y.target;
        if (!el) return;
        e.preventDefault();
        // The lane an editor marks its changes in lies under this one (SCR-09):
        // a press on a mark goes to the mark, and pages nothing.
        const mark = document.elementsFromPoint(e.clientX, e.clientY).find((n): n is HTMLElement => n instanceof HTMLElement && n.dataset.scrollMark !== undefined);
        if (mark) { mark.click(); return; }
        const thumbBox = rails.y.thumb.getBoundingClientRect();
        el.scrollTop += (e.clientY < thumbBox.top ? -1 : 1) * el.clientHeight;
        show("y", el);
      });
      layer.append(track);
    }
    thumb.addEventListener("pointerdown", (e) => drag(axis, e));
    layer.append(thumb);
  }
  document.body.append(layer);

  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target as HTMLElement | null;
      if (!(el instanceof HTMLElement) || !allowed(el)) return;
      for (const axis of AXES) if (scrolls(el, axis)) show(axis, el);
    },
    true,
  );
  document.addEventListener("pointermove", onPointer, true);
  // A resize moves every edge the bars are pinned to.
  window.addEventListener("resize", () => AXES.forEach(hide));
}
