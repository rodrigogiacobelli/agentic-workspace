// What every tab strip shares: the wheel scrolls it sideways, the active tab
// is scrolled into view when it changes by hotkey or from a list, and whatever
// will not fit is reachable from one control at the end of the strip, so a tab
// that has scrolled out of view is never lost (TAB-01, TAB-02, TAB-03). A tab
// is dragged by the pointer, and its strip opens a gap where it will land
// (TAB-09 to TAB-15).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { duration } from "../motion";
import { Icon } from "./icons";
import { MenuButton } from "./Menu";
import type { Zone } from "./SplitTree";

export interface TabStrip {
  ref: React.RefObject<HTMLDivElement | null>;
  onWheel: (e: React.WheelEvent<HTMLDivElement>) => void;
  /** Tabs whose full width is not on screen. */
  hidden: number;
}

export function useTabStrip(activeId: string | null, count: number): TabStrip {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const strip = el.getBoundingClientRect();
    let out = 0;
    for (const tab of el.querySelectorAll<HTMLElement>("[data-tab]")) {
      const box = tab.getBoundingClientRect();
      if (box.left < strip.left - 1 || box.right > strip.right + 1) out += 1;
    }
    setHidden(out);
  }, []);

  useLayoutEffect(() => {
    if (activeId) {
      const tab = ref.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(activeId)}"]`);
      tab?.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
    measure();
  }, [activeId, count, measure]);

  // The group is resized by a divider as often as by the window.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
    measure();
  };

  return { ref, onWheel, hidden };
}

export interface TabEntry {
  id: string;
  label: ReactNode;
  active: boolean;
}

/** Every tab in the strip, in strip order, whether or not it is on screen. */
export function TabOverflow({ strip, entries, onPick }: { strip: TabStrip; entries: TabEntry[]; onPick: (id: string) => void }) {
  if (strip.hidden === 0) return null;
  return (
    <MenuButton
      className="tabs-overflow"
      title={`${strip.hidden} tab${strip.hidden === 1 ? "" : "s"} out of view`}
      label={
        <>
          <Icon name="chevronDown" size={12} />
          <span className="tabs-overflow-count">{strip.hidden}</span>
        </>
      }
    >
      <div className="tab-list">
        {entries.map((entry) => (
          <button key={entry.id} className={entry.active ? "selected" : ""} onClick={() => onPick(entry.id)}>
            <span className="menu-label">{entry.label}</span>
          </button>
        ))}
      </div>
    </MenuButton>
  );
}

// --- Dragging a tab ----------------------------------------------------------
//
// The drag is the page's own, on pointer events, because a native drag image
// cannot move the tabs beside it. The pressed tab stays in its strip, hidden,
// holding its place; a copy of it follows the pointer above everything, and
// the tabs of the strip under the pointer are translated aside to open a gap
// where a release lands it. A strip is a `.tabs` element, positioned so its
// tabs' offsets are read against it, and a tab carries its id in `data-tab`.
// Nothing moves in the DOM until the move made on the drop comes back from the
// backend and React draws it; the marks come off before that frame is painted.

/** A split zone of an editor group, where a dragged editor tab lands besides a strip. */
export interface TabZone {
  group: string;
  zone: Zone;
}

/** A place in a strip: before its `index`th tab other than the dragged one, or after the last. */
interface Slot {
  strip: HTMLElement;
  index: number;
}

type Over = Slot | { zone: TabZone } | null;

/** Where a released tab lands. `order` is the strip's tab ids with the dragged tab at `index`. */
export type TabDrop = (Slot & { order: string[] }) | { zone: TabZone };

export interface TabDragOptions {
  /** A strip's tabs that a dragged tab lands among, in strip order. */
  tabsOf(strip: HTMLElement): HTMLElement[];
  /** What lies at a point: a strip, a zone, or nothing, where a release puts the tab back. */
  hit(x: number, y: number): { strip: HTMLElement } | { zone: TabZone } | null;
  /** Draws the zone under the pointer, or clears it. */
  showZone?(zone: TabZone | null): void;
  /** Makes the move. */
  drop(to: TabDrop): Promise<unknown>;
}

/** How far a press travels before it is a drag; a release short of it is a click. */
const THRESHOLD = 5;
/** How long a drop's marks wait for its move to be drawn, once the backend has answered, before they come off regardless. */
const ARRIVAL_MS = 250;
/** How long a drop's marks wait for a backend that has not answered at all. */
const ANSWER_MS = 1000;

/** Lands the last drag at once, when another starts before it has. */
let finish: (() => void) | null = null;
/** Takes the marks off a drag whose move is on its way, once a strip the move changes has changed. */
let arrived: (() => void) | null = null;

/**
 * Called by every strip in a layout effect when its tabs change. When a strip
 * the pending drop moves a tab out of or into is among them, the move has
 * been drawn, and the drag's marks come off in the same frame, so no tab is
 * seen back in its old place first. Another strip changing leaves them on.
 */
export function settleTabDrag(): void {
  arrived?.();
}

const stop = (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
};

/** Flips `data-moved`, which restarts an element's fade in place under reduced motion (`styles.css`). */
function moved(el: HTMLElement): void {
  el.dataset.moved = el.dataset.moved === "a" ? "b" : "a";
}

function same(a: Over, b: Over): boolean {
  if (!a || !b) return a === b;
  if ("strip" in a) return "strip" in b && a.strip === b.strip && a.index === b.index;
  return "zone" in b && a.zone.group === b.zone.group && a.zone.zone === b.zone.zone;
}

/**
 * The slot a pointer at `x` picks among tabs laid out with the dragged tab's
 * place closed and a gap `width` wide open before tab `gap`: before the first
 * tab whose middle, where it is drawn, lies right of the pointer, else after
 * the last. Over a tab's left half that is the slot before it, over its right
 * half the slot after it, and over the gap the gap itself.
 */
function slotAt(x: number, tabs: { left: number; width: number }[], gap: number | null, width: number): number {
  const i = tabs.findIndex((t, j) => x < t.left + t.width / 2 + (gap !== null && j >= gap ? width : 0));
  return i < 0 ? tabs.length : i;
}

/**
 * Watches a press on a tab. Moved past `THRESHOLD`, the tab is dragged:
 * Escape, a release over nothing, or the pointer lost to another window puts
 * it back; a release over a slot or a zone moves it there (TAB-09 to TAB-15).
 */
export function dragTab(down: React.PointerEvent<HTMLElement>, o: TabDragOptions): void {
  if (down.button !== 0 || !down.isPrimary || (down.target as Element).closest("button, input")) return;
  const tab = down.currentTarget;
  const home = tab.parentElement;
  const from = home ? o.tabsOf(home).indexOf(tab) : -1;
  if (!home || from < 0) return;
  const id = tab.dataset.tab ?? "";
  const { pointerId, clientX: x0, clientY: y0 } = down;
  let point = { x: x0, y: y0 };
  let grab = { x: 0, y: 0 };
  let width = 0;
  let ghost: HTMLElement | null = null;
  let line: HTMLElement | null = null;
  let lineAt: { strip: HTMLElement; place: string } | null = null;
  let over: Over = null;
  let landing: TabDrop | null = null;
  let released = false;
  let done = false;
  let timer = 0;
  // Every strip the drag has passed over, and the shift it gave each tab there.
  const strips = new Set<HTMLElement>([home]);
  const shifts = new Map<HTMLElement, number>();

  // A strip's tabs other than the dragged one, in viewport x, where they
  // stand with the dragged tab's place closed; and where the last one ends.
  const closed = (strip: HTMLElement) => {
    const base = strip.getBoundingClientRect().left + strip.clientLeft - strip.scrollLeft;
    const tabs: { el: HTMLElement; left: number; width: number; shift: number }[] = [];
    let shift = 0;
    for (const el of o.tabsOf(strip)) {
      if (el === tab) shift = -width;
      else tabs.push({ el, left: base + el.offsetLeft + shift, width: el.offsetWidth, shift });
    }
    const last = tabs[tabs.length - 1];
    if (last) return { tabs, end: last.left + last.width };
    // With none, the gap opens after whatever the strip holds in front of
    // them: an editor group's panel tabs.
    const lead = Array.from(strip.querySelectorAll<HTMLElement>(":scope > [data-tab]")).filter((el) => el !== tab).pop();
    return { tabs, end: base + (lead ? lead.offsetLeft + lead.offsetWidth : 0) };
  };
  // The gap: at the pointer's slot, or at the tab's own place while the
  // pointer is over nothing. Over a zone no strip holds one.
  const gap = (): Slot | null => (over && "strip" in over ? over : over ? null : { strip: home, index: from });
  const slotPoint = (slot: Slot) => {
    const { tabs, end } = closed(slot.strip);
    return { x: tabs[slot.index]?.left ?? end, y: slot.strip.getBoundingClientRect().top };
  };
  const orderOf = (slot: Slot) => {
    const ids = o.tabsOf(slot.strip).map((el) => el.dataset.tab ?? "").filter((t) => t !== id);
    ids.splice(slot.index, 0, id);
    return ids;
  };

  // Everything is read before anything is written.
  const layout = () => {
    const open = gap();
    const shifted: [HTMLElement, number][] = [];
    for (const strip of strips) {
      const at = open?.strip === strip ? open.index : null;
      closed(strip).tabs.forEach((t, j) => shifted.push([t.el, t.shift + (at !== null && j >= at ? width : 0)]));
    }
    const mark = over && "strip" in over ? over : null;
    const r = mark?.strip.getBoundingClientRect();
    const x = mark && r ? Math.min(Math.max(slotPoint(mark).x, r.left), r.right - 2) : 0;
    for (const [el, dx] of shifted) {
      if ((shifts.get(el) ?? 0) === dx) continue;
      shifts.set(el, dx);
      el.style.transform = dx ? `translateX(${dx}px)` : "";
      moved(el);
    }
    // The insertion line marks a slot the pointer is over, never the way back.
    if (!mark || !r) {
      line?.remove();
      line = lineAt = null;
      return;
    }
    const place = `translate(${x}px, ${r.top}px)`;
    if (!line || lineAt?.strip !== mark.strip) {
      line?.remove();
      line = document.createElement("div");
      line.className = "tab-drop-line";
      line.style.height = `${r.height}px`;
      document.body.append(line);
    } else if (lineAt.place !== place) moved(line);
    line.style.transform = place;
    lineAt = { strip: mark.strip, place };
  };

  const track = () => {
    const hit = o.hit(point.x, point.y);
    let next: Over = hit && "zone" in hit ? hit : null;
    if (hit && "strip" in hit) {
      const r = hit.strip.getBoundingClientRect();
      const open = gap();
      const x = Math.min(Math.max(point.x, r.left), r.right);
      next = { strip: hit.strip, index: slotAt(x, closed(hit.strip).tabs, open?.strip === hit.strip ? open.index : null, width) };
    }
    if (!same(next, over)) {
      over = next;
      o.showZone?.(over && "zone" in over ? over.zone : null);
      if (over && "strip" in over && !strips.has(over.strip)) {
        strips.add(over.strip);
        over.strip.dataset.dragging = "";
      }
    }
    layout();
  };

  const begin = (): HTMLElement => {
    finish?.();
    finish = flush;
    const r = tab.getBoundingClientRect();
    grab = { x: x0 - r.left, y: y0 - r.top };
    width = tab.offsetWidth;
    const copy = tab.cloneNode(true) as HTMLElement;
    copy.removeAttribute("data-tab");
    copy.classList.add("tab-ghost");
    copy.style.width = `${r.width}px`;
    copy.style.height = `${r.height}px`;
    document.body.append(copy);
    tab.style.opacity = "0";
    home.dataset.dragging = "";
    try {
      tab.setPointerCapture(pointerId);
    } catch {
      // The pointer is already up; its pointerup on the window ends the drag.
    }
    tab.addEventListener("lostpointercapture", cancel);
    window.addEventListener("keydown", key, true);
    document.addEventListener("selectstart", stop, true);
    document.addEventListener("scroll", track, true);
    return (ghost = copy);
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (!(e.buttons & 1)) {
      cancel();
      return;
    }
    if (released) return;
    point = { x: e.clientX, y: e.clientY };
    if (!ghost && Math.hypot(point.x - x0, point.y - y0) < THRESHOLD) return;
    (ghost ?? begin()).style.transform = `translate(${point.x - grab.x}px, ${point.y - grab.y}px)`;
    track();
  };

  // Lands the tab in its slot, or puts it back. The pointer's own listeners
  // stay until its release or its loss is seen (`off`): after Escape the
  // button is still down, and the click it makes is the drag's.
  const release = (commit: boolean) => {
    released = true;
    window.removeEventListener("keydown", key, true);
    document.removeEventListener("selectstart", stop, true);
    document.removeEventListener("scroll", track, true);
    if (!ghost) return;
    o.showZone?.(null);
    const to = commit ? over : null;
    if (to && "zone" in to) {
      hold(to);
      return;
    }
    if (!to) {
      over = null;
      layout();
    }
    line?.remove();
    line = lineAt = null;
    // The tab slides from under the pointer into its gap, and the move is
    // made once it is there.
    const slot = to ?? { strip: home, index: from };
    const { x, y } = slotPoint(slot);
    ghost.classList.add("settling");
    moved(ghost);
    ghost.style.transform = `translate(${x}px, ${y}px)`;
    if (to && (to.strip !== home || to.index !== from)) landing = { ...to, order: orderOf(to) };
    timer = window.setTimeout(land, duration("--d-quick"));
  };

  const off = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    window.removeEventListener("blur", cancel);
    tab.removeEventListener("lostpointercapture", cancel);
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    off();
    if (ghost) {
      // The click this release makes belongs to the drag, not to the tab under it.
      window.addEventListener("click", stop, true);
      window.setTimeout(() => window.removeEventListener("click", stop, true));
    }
    if (!released) release(e.type === "pointerup");
  };

  // The pointer went where this window cannot follow it: the compositor took
  // it for another window or the overview, or the button came up unseen. The
  // drag is put back as Escape puts it (TAB-13), and no release is waited for,
  // so the next click is a click.
  const cancel = () => {
    off();
    if (!released) release(false);
  };

  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    stop(e);
    release(false);
  };

  const land = () => {
    const to = landing;
    landing = null;
    if (to) hold(to);
    else cleanup();
  };

  // The strips a drop changes, and the tabs each held before it: the tab
  // leaves its own strip, or moves within it, and enters the one it lands in.
  let moving: { strip: HTMLElement; ids: string }[] = [];
  const idsOf = (strip: HTMLElement) => o.tabsOf(strip).map((el) => el.dataset.tab).join("\n");
  const drawn = () => {
    if (moving.some((m) => !m.strip.isConnected || idsOf(m.strip) !== m.ids)) cleanup();
  };

  // The marks stay until the move is drawn (`settleTabDrag`). A move refused,
  // one that changes no strip, or one the backend never answers still ends
  // the drag.
  const hold = (to: TabDrop) => {
    moving = ("strip" in to && to.strip !== home ? [home, to.strip] : [home]).map((strip) => ({ strip, ids: idsOf(strip) }));
    arrived = drawn;
    timer = window.setTimeout(cleanup, ANSWER_MS);
    const late = () => {
      if (done) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(cleanup, ARRIVAL_MS);
    };
    void o.drop(to).then(late, late);
  };

  const flush = () => {
    const to = landing;
    landing = null;
    if (to) void o.drop(to);
    cleanup();
  };

  const cleanup = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    if (finish === flush) finish = null;
    if (arrived === drawn) arrived = null;
    ghost?.remove();
    line?.remove();
    for (const strip of strips) delete strip.dataset.dragging;
    for (const el of shifts.keys()) {
      el.style.transform = "";
      delete el.dataset.moved;
    }
    tab.style.opacity = "";
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  window.addEventListener("blur", cancel);
}
