// App-drawn menus. A native popup in WebKitGTK closes the moment the element
// behind it re-renders, and the Workspace window re-renders on every git and
// file-tree event; a menu drawn by the app stays open until it is dismissed.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  /** What a click does. A row without it only groups the rows under it: a
   *  click opens or closes it, and it offers no actions (BR-14a). */
  onPick?: () => void;
  onRename?: () => void;
  /** What the rename control says it does, when "Rename" is not it. */
  renameLabel?: string;
  onRemove?: () => void;
  /** Rows nested under this one, revealed by its disclosure. */
  children?: Row[];
  /** The list this row is dragged within, when the menu reorders: a row
   *  takes a drop only from a row of the same list, and one without drags
   *  nowhere. */
  siblings?: string;
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
  /**
   * Rows that name their `siblings` are dragged into a new order within that
   * list: a drop puts the dragged row before the one it lands on, or last
   * when it lands on the lower half of a nested list's last row or, for the
   * top-level rows, on the footer (`before` is null). `mime` names the drag,
   * so a row accepts only its own list's.
   */
  reorder?: { mime: string; onMove: (id: string, before: string | null, siblings: string) => void };
}

/** Where a drag over the footer lands: after every top-level row. */
const END = Symbol("end");

/** Where a drag would land: before the row named, after it, or at the end. */
type Over = { at: string | typeof END; after: boolean };

/** Whether a row holds the selection anywhere below it. */
const holdsSelection = (r: Row): boolean => !!r.children?.some((c) => c.selected || holdsSelection(c));

/** A selector whose rows carry their own rename and remove actions on the right. */
export function RowMenu({ label, title, className, rows, footer, empty, minWidth = 280, align = "start", reorder }: RowMenuProps) {
  const [open, setOpen] = useState<{ x: number; y: number; width: number } | null>(null);
  /** Rows opened or closed by hand; any other is open while it holds the selection. */
  const [expanded, setExpanded] = useState<Map<string, boolean>>(new Map());
  const [over, setOver] = useState<Over | null>(null);
  /** The row being dragged. Held here because WebKit hides a drag's data
   *  until the drop, and whether a row takes it depends on its list. */
  const dragged = useRef<{ id: string; siblings: string; top: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    if (open) { setOpen(null); return; }
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    // A row closed by hand opens again on the selection the next time the
    // list does (BR-14); one opened by hand stays open.
    setExpanded((all) => new Map([...all].filter(([, opened]) => opened)));
    setOpen({ x: align === "center" ? r.left + r.width / 2 : r.left, y: r.bottom + 2, width: Math.max(r.width, minWidth) });
  };
  // A row that holds the current selection opens itself, at every level: the
  // one thing the list has to show is where you already are (BR-14).
  const isOpen = (r: Row) => expanded.get(r.id) ?? holdsSelection(r);
  const disclose = (r: Row) => setExpanded((all) => new Map(all).set(r.id, !(all.get(r.id) ?? holdsSelection(r))));

  /**
   * What makes an element take the dragged row: before the row `at`, after
   * it when the pointer is on the lower half of a nested list's last row, or
   * last when `at` is the footer. `accepts` says whether the row being
   * dragged belongs to this list. The drop is accepted on `dragenter` as well
   * as `dragover`: WebKit fires only the enter on the motion that crosses
   * into an element, and a refused enter refuses a release on that motion.
   * It leaves `relatedTarget` null on drag events, so a leave into the
   * element's own children is told apart by what is under the pointer.
   */
  const target = (at: string | typeof END, accepts: (d: { siblings: string; top: boolean }) => boolean, last = false) => {
    if (!reorder) return undefined;
    const where = (e: React.DragEvent): Over => {
      const r = e.currentTarget.getBoundingClientRect();
      return { at, after: last && e.clientY > r.top + r.height / 2 };
    };
    const accept = (e: React.DragEvent) => {
      const d = dragged.current;
      if (!e.dataTransfer.types.includes(reorder.mime) || !d || !accepts(d)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const next = where(e);
      setOver((o) => (o?.at === next.at && o.after === next.after ? o : next));
    };
    return {
      onDragEnter: accept,
      onDragOver: accept,
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(document.elementFromPoint(e.clientX, e.clientY))) setOver((o) => (o?.at === at ? null : o));
      },
      // A drop moves the row and nothing more: no click follows a drag, and
      // the list stays open on the new order.
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setOver(null);
        const d = dragged.current;
        const id = e.dataTransfer.getData(reorder.mime) || d?.id;
        if (!id || !d || !accepts(d)) return;
        const before = at === END || where(e).after ? null : at;
        if (id !== before) reorder.onMove(id, before, d.siblings);
      },
    };
  };

  const renderRow = (r: Row, depth: number, last: boolean): ReactNode => {
    const shown = isOpen(r);
    // A row drags within its own list only: a child among its root's
    // children, a root among the roots. A worktree, the group of worktrees
    // and a row alone in its list name none and stay where they are (WS-18).
    // The data is set because WebKitGTK starts no drag whose data transfer
    // is empty.
    const siblings = r.siblings;
    const drag = reorder && siblings !== undefined ? {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        dragged.current = { id: r.id, siblings, top: depth === 0 };
        e.dataTransfer.setData(reorder.mime, r.id);
        e.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => { dragged.current = null; setOver(null); },
      ...target(r.id, (d) => d.siblings === siblings, last && depth > 0),
    } : undefined;
    const marked = drag && over?.at === r.id ? (over.after ? " drop-after" : " drop-before") : "";
    const pick = r.onPick;
    return (
      <Fragment key={r.id}>
        {/* No `title`: the row already prints its path, and a tooltip repeating
            it lands over the rows underneath. */}
        <div
          className={`row${r.selected ? " selected" : ""}${depth > 0 ? " row-nested" : ""}${marked}`}
          style={{ "--depth": depth } as CSSProperties}
          onClick={() => {
            if (!pick) return disclose(r);
            setOpen(null);
            pick();
          }}
          {...drag}
        >
          {!!r.children?.length && (
            <button
              className={`row-disclose${shown ? " open" : ""}`}
              title={shown ? "Collapse" : "Expand"}
              aria-expanded={shown}
              onClick={(e) => { e.stopPropagation(); disclose(r); }}
            >▸</button>
          )}
          <span className="row-text">
            <span className="row-name">{r.name}</span>
            {r.detail && <span className="row-detail">{r.detail}</span>}
          </span>
          {pick && (r.onRename || r.onRemove) && (
            <span className="row-actions" onClick={(e) => e.stopPropagation()}>
              {r.onRename && <button title={r.renameLabel ?? "Rename"} onClick={() => { setOpen(null); r.onRename!(); }}><Icon name="rename" size={13} /></button>}
              {r.onRemove && <button title="Remove" onClick={() => { setOpen(null); r.onRemove!(); }}><Icon name="close" size={13} /></button>}
            </span>
          )}
        </div>
        {shown && r.children?.map((c, i, all) => renderRow(c, depth + 1, i === all.length - 1))}
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
            {rows.map((r, i) => renderRow(r, 0, i === rows.length - 1))}
            {rows.length === 0 && empty && <div className="palette-empty">{empty}</div>}
            {footer && (
              <>
                <hr className={over?.at === END ? "drop-at" : undefined} />
                <button className="row-footer" onClick={() => { setOpen(null); footer.onClick(); }} {...target(END, (d) => d.top)}>{footer.label}</button>
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
