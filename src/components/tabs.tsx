// What every tab strip shares: the wheel scrolls it sideways, the active tab
// is scrolled into view when it changes by hotkey or from a list, and whatever
// will not fit is reachable from one control at the end of the strip, so a tab
// that has scrolled out of view is never lost (TAB-01, TAB-02, TAB-03).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { MenuButton } from "./Menu";

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
