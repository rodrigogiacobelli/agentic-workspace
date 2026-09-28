// App-drawn menus. A native popup in WebKitGTK closes the moment the element
// behind it re-renders, and the Workspace window re-renders on every git and
// file-tree event; a menu drawn by the app stays open until it is dismissed.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../motion";
import { Icon } from "./icons";

/**
 * A menu anchored at a point, dismissed by a click elsewhere or Escape. `x` is
 * the menu's left edge, or the point it is centred on when `align` says so.
 */
export function ContextMenu({ x, y, align = "start", anchor, onClose, children }: { x: number; y: number; align?: "start" | "center"; anchor?: unknown; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Dismissal plays the exit; picking a row does not, as on a platform menu:
  // what the row did is the acknowledgement, and a fade over it reads as lag.
  const [closing, dismiss, cancel] = useDismiss(onClose, "--d-exit");
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) dismiss(); };
    // The Escape is the menu's alone: a menu opened inside a dialog closes,
    // and the dialog under it — which closes on an Escape nobody claimed —
    // stays.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", down, true); window.removeEventListener("keydown", key, true); };
  }, [dismiss]);
  // A new opening is a new menu, whatever the last one was doing — including
  // one opened at the very pixel the last was dismissed from, so what marks it
  // is the identity of the state that opened it, not its coordinates.
  useLayoutEffect(cancel, [anchor ?? `${x},${y}`, cancel]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Centring needs the width the rows and the menu's own padding settled on,
    // which only the laid-out element knows.
    let r = el.getBoundingClientRect();
    if (align === "center") {
      el.style.left = `${Math.max(4, x - r.width / 2)}px`;
      r = el.getBoundingClientRect();
    }
    // Keep the menu on screen when it opens near the bottom or right edge.
    if (r.right > window.innerWidth) el.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
  }, [x, y, align]);
  // On the body: a panel's region is a size container, and a size container is
  // the box a fixed element is placed in, so a menu inside one would open
  // offset by the region's corner and clipped to it.
  return createPortal(
    <div ref={ref} className={`menu${closing ? " is-closing" : ""}`} style={{ left: x, top: y }} data-tauri-drag-region="false">
      {children}
    </div>,
    document.body,
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
        <ContextMenu x={open.x} y={open.y} anchor={open} onClose={() => setOpen(null)}>
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
  /** What the rename control says it does, when "Rename" is not it. */
  renameLabel?: string;
  onRemove?: () => void;
  /** Rows nested under this one, revealed by its disclosure. */
  children?: Row[];
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
  /** Where the list sits under the control: at its left edge, or centred on it. */
  align?: "start" | "center";
}

/** A selector whose rows carry their own rename and remove actions on the right. */
export function RowMenu({ label, title, className, rows, footer, empty, minWidth = 280, align = "start" }: RowMenuProps) {
  const [open, setOpen] = useState<{ x: number; y: number; width: number } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const button = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    if (open) { setOpen(null); return; }
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    setOpen({ x: align === "center" ? r.left + r.width / 2 : r.left, y: r.bottom + 2, width: Math.max(r.width, minWidth) });
  };
  const disclose = (id: string) =>
    setExpanded((all) => {
      const next = new Set(all);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const renderRow = (r: Row, nested: boolean): ReactNode => {
    // A row that holds the current selection opens itself: the one thing the
    // list has to show is where you already are.
    const isOpen = expanded.has(r.id) || !!r.children?.some((c) => c.selected);
    return (
      <Fragment key={r.id}>
        {/* No `title`: the row already prints its path, and a tooltip repeating
            it lands over the rows underneath. */}
        <div className={`row${r.selected ? " selected" : ""}${nested ? " row-nested" : ""}`} onClick={() => { setOpen(null); r.onPick(); }}>
          {!!r.children?.length && (
            <button
              className={`row-disclose${isOpen ? " open" : ""}`}
              title={isOpen ? "Hide worktrees" : "Show worktrees"}
              aria-expanded={isOpen}
              onClick={(e) => { e.stopPropagation(); disclose(r.id); }}
            >▸</button>
          )}
          <span className="row-text">
            <span className="row-name">{r.name}</span>
            {r.detail && <span className="row-detail">{r.detail}</span>}
          </span>
          {(r.onRename || r.onRemove) && (
            <span className="row-actions" onClick={(e) => e.stopPropagation()}>
              {r.onRename && <button title={r.renameLabel ?? "Rename"} onClick={() => { setOpen(null); r.onRename!(); }}><Icon name="rename" size={13} /></button>}
              {r.onRemove && <button title="Remove" onClick={() => { setOpen(null); r.onRemove!(); }}><Icon name="close" size={13} /></button>}
            </span>
          )}
        </div>
        {isOpen && r.children?.map((c) => renderRow(c, true))}
      </Fragment>
    );
  };

  return (
    <>
      <button ref={button} className={`dropdown${className ? ` ${className}` : ""}${open ? " open" : ""}`} onClick={toggle} title={title} aria-haspopup="menu" aria-expanded={!!open}>
        <span className="dropdown-value">{label}</span>
        <span className="dropdown-caret">▾</span>
      </button>
      {open && (
        <ContextMenu x={open.x} y={open.y} align={align} anchor={open} onClose={() => setOpen(null)}>
          <div className="row-menu" style={{ minWidth: open.width }}>
            {rows.map((r) => renderRow(r, false))}
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
        <ContextMenu x={open.x} y={open.y} anchor={open} onClose={() => setOpen(null)}>
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
