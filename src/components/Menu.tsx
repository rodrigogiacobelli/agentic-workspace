// App-drawn menus. A native popup in WebKitGTK closes the moment the element
// behind it re-renders, and the Workspace window re-renders on every git and
// file-tree event; a menu drawn by the app stays open until it is dismissed.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** A menu anchored at a point, dismissed by a click elsewhere or Escape. */
export function ContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", down, true); window.removeEventListener("keydown", key, true); };
  }, [onClose]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Keep the menu on screen when it opens near the bottom or right edge.
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) el.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
  }, [x, y]);
  return (
    <div ref={ref} className="menu" style={{ left: x, top: y }} data-tauri-drag-region="false">
      {children}
    </div>
  );
}

/** A button that opens a menu of actions beneath itself. */
export function MenuButton({ label, title, className, children }: { label: ReactNode; title?: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    if (open) { setOpen(null); return; }
    const r = button.current?.getBoundingClientRect();
    if (r) setOpen({ x: r.left, y: r.bottom + 2 });
  };
  return (
    <>
      <button ref={button} className={`${className ?? ""}${open ? " open" : ""}`} onClick={toggle} title={title} aria-haspopup="menu" aria-expanded={!!open}>{label}</button>
      {open && (
        <ContextMenu x={open.x} y={open.y} onClose={() => setOpen(null)}>
          <div onClick={() => setOpen(null)}>{children}</div>
        </ContextMenu>
      )}
    </>
  );
}

/** A menu entry that opens its children beside it, for a list that can grow. */
export function SubMenu({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) { el.style.left = "auto"; el.style.right = "100%"; }
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(-r.top, window.innerHeight - r.bottom)}px`;
  }, [open]);
  return (
    <div className="submenu" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button onClick={() => setOpen((o) => !o)}>
        <span className="menu-label">{label}</span>
        <span className="menu-hint">▸</span>
      </button>
      {open && <div ref={list} className="menu submenu-list">{children}</div>}
    </div>
  );
}

export interface Row {
  id: string;
  name: ReactNode;
  detail?: string;
  selected?: boolean;
  onPick: () => void;
  onRename?: () => void;
  onRemove?: () => void;
}

interface RowMenuProps {
  /** What the closed control shows. */
  label: ReactNode;
  title?: string;
  className?: string;
  rows: Row[];
  /** A row at the bottom that adds something. */
  footer?: { label: ReactNode; onClick: () => void };
  empty?: string;
  minWidth?: number;
}

/** A selector whose rows carry their own rename and remove actions on the right. */
export function RowMenu({ label, title, className, rows, footer, empty, minWidth = 280 }: RowMenuProps) {
  const [open, setOpen] = useState<{ x: number; y: number; width: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    if (open) { setOpen(null); return; }
    const r = button.current?.getBoundingClientRect();
    if (r) setOpen({ x: r.left, y: r.bottom + 2, width: Math.max(r.width, minWidth) });
  };
  return (
    <>
      <button ref={button} className={`dropdown${className ? ` ${className}` : ""}${open ? " open" : ""}`} onClick={toggle} title={title} aria-haspopup="menu" aria-expanded={!!open}>
        <span className="dropdown-value">{label}</span>
        <span className="dropdown-caret">▾</span>
      </button>
      {open && (
        <ContextMenu x={open.x} y={open.y} onClose={() => setOpen(null)}>
          <div className="row-menu" style={{ minWidth: open.width }}>
            {rows.map((r) => (
              <div key={r.id} className={`row${r.selected ? " selected" : ""}`} onClick={() => { setOpen(null); r.onPick(); }} title={r.detail}>
                <span className="row-name">{r.name}</span>
                {r.detail && <span className="row-detail">{r.detail}</span>}
                {(r.onRename || r.onRemove) && (
                  <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {r.onRename && <button title="Rename" onClick={() => { setOpen(null); r.onRename!(); }}>✎</button>}
                    {r.onRemove && <button title="Remove" onClick={() => { setOpen(null); r.onRemove!(); }}>✕</button>}
                  </span>
                )}
              </div>
            ))}
            {rows.length === 0 && empty && <div className="palette-empty">{empty}</div>}
            {footer && (
              <>
                <hr />
                <button className="row-footer" onClick={() => { setOpen(null); footer.onClick(); }}>{footer.label}</button>
              </>
            )}
          </div>
        </ContextMenu>
      )}
    </>
  );
}

export interface Option {
  id: string;
  label: string;
  detail?: string;
}

interface DropdownProps {
  value: string;
  options: Option[];
  onChange: (id: string) => void;
  /** What the closed control shows; defaults to the selected option's label. */
  display?: ReactNode;
  className?: string;
  title?: string;
}

/** A select control whose list is drawn by the app rather than the platform. */
export function Dropdown({ value, options, onChange, display, className, title }: DropdownProps) {
  const [open, setOpen] = useState<{ x: number; y: number; width: number } | null>(null);
  const [index, setIndex] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const selected = options.find((o) => o.id === value);

  const toggle = () => {
    if (open) { setOpen(null); return; }
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    setIndex(Math.max(0, options.findIndex((o) => o.id === value)));
    setOpen({ x: r.left, y: r.bottom + 2, width: r.width });
  };

  const pick = (id: string) => {
    setOpen(null);
    if (id !== value) onChange(id);
    button.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, options.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (options[index]) pick(options[index].id); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(null); }
  };

  return (
    <>
      <button
        ref={button}
        className={`dropdown${className ? ` ${className}` : ""}${open ? " open" : ""}`}
        onClick={toggle}
        onKeyDown={onKey}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={!!open}
      >
        <span className="dropdown-value">{display ?? selected?.label ?? ""}</span>
        <span className="dropdown-caret">▾</span>
      </button>
      {open && (
        <ContextMenu x={open.x} y={open.y} onClose={() => setOpen(null)}>
          <div className="dropdown-list" role="listbox" style={{ minWidth: open.width }}>
            {options.map((o, i) => (
              <button
                key={o.id}
                role="option"
                aria-selected={o.id === value}
                className={`${o.id === value ? "selected" : ""}${i === index ? " focused" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(o.id)}
              >
                <span>{o.label}</span>
                {o.detail && <span className="dropdown-detail">{o.detail}</span>}
              </button>
            ))}
          </div>
        </ContextMenu>
      )}
    </>
  );
}
