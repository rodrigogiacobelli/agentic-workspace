// What every tab strip shares: the wheel scrolls it sideways, and the active
// tab is scrolled into view when it changes by hotkey or from a list.

import { useEffect, useRef } from "react";

export function useTabStrip(activeId: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeId) return;
    const tab = ref.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(activeId)}"]`);
    tab?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
  };
  return { ref, onWheel };
}
