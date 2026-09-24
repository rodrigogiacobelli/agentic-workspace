import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../motion";
import { rank } from "../fuzzy";

export interface PaletteItem {
  id: string;
  label: string;
  detail?: string;
}

interface Props {
  title: string;
  items: PaletteItem[];
  onPick: (item: PaletteItem) => void;
  onClose: () => void;
}

/** A filterable list overlay: type to narrow, arrows to move, Enter to pick. */
export function Palette({ title, items, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => rank(query, items, (i) => i.label), [query, items]);
  const [closing, dismiss] = useDismiss(onClose);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

  const onKey = (e: React.KeyboardEvent) => {
    // The exit is still on screen; the list must not still answer for it.
    if (closing) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (matches[index]) onPick(matches[index]); }
    else if (e.key === "Escape") { e.preventDefault(); dismiss(); }
  };

  // On the body: a panel's region is a size container, and that would make it
  // the box a fixed overlay is placed in.
  return createPortal(
    <div className={`overlay${closing ? " is-closing" : ""}`} onMouseDown={dismiss}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          ref={input}
          className="palette-input"
          placeholder={title}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="palette-list">
          {matches.map((item, i) => (
            <li
              key={item.id}
              className={i === index ? "selected" : ""}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onPick(item)}
            >
              <span className="palette-label">{item.label}</span>
              {item.detail && <span className="palette-detail">{item.detail}</span>}
            </li>
          ))}
          {matches.length === 0 && <li className="palette-empty">No matches</li>}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
