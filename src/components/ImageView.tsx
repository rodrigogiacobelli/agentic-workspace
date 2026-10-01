// The image viewer: an image tab's picture, fitted, zoomed, panned, turned and
// mirrored as the reader asks, and never the file itself (IMG-01 to IMG-12).
//
// The viewer is a scroller over a stage at least its own size, so panning is
// scrolling: the application's wheel glide and its scrollbars move it as they
// move everything else (IMG-11), and no pan can take the picture out of the
// tab (IMG-04). The picture is sized, not scaled, so a vector image is drawn
// again at every zoom and stays sharp (IMG-10). What the reader set is kept
// per tab for the life of the process (ADR-018), where the header's controls
// and the status bar read it too.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../api";
import * as editors from "../editors";
import { keep, peek, useKept } from "../live";
import { duration, easing } from "../motion";
import { report } from "../notice";
import type { EditorTab, Workspace } from "../types";
import { Icon, type IconName } from "./icons";
import { ContextMenu } from "./Menu";

export interface ImageState {
  /** Fitted to the tab, and fitted again as the tab is resized or the picture turned. */
  fit: boolean;
  /** Image pixels to CSS pixels as drawn; while fitted, the fit last worked out. */
  scale: number;
  /** Quarter turns clockwise, counted without wrapping, so every turn animates the short way. */
  turns: number;
  /** Mirrored along the picture's own axes, before it is turned. */
  flipX: boolean;
  flipY: boolean;
  /** The picture's own size, once it has loaded; 0 until then. */
  width: number;
  height: number;
  /** What the last double-click zoomed from, and to, for the next to go back (IMG-03a). */
  back: { fit: boolean; scale: number; to: number } | null;
}

const INITIAL: ImageState = { fit: true, scale: 1, turns: 0, flipX: false, flipY: false, width: 0, height: 0, back: null };

/** ＋ and −'s steps (IMG-02); the wheel zooms anywhere between the ends. */
const STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const MIN = STEPS[0];
const MAX = STEPS[STEPS.length - 1];
/** How much Ctrl+wheel zooms per 100 px of wheel travel (IMG-02a). */
const WHEEL_RATE = 1.25;
/** What a wheel reporting lines travels per line, as `wheel.ts` counts it. */
const LINE_PX = 40;
/** How far an arrow key pans (IMG-04). */
const ARROW_PX = 40;
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** The room a fitted picture leaves around itself. */
const MARGIN = 16;

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

function keyOf(workspaceId: string, tabId: string): string {
  return `${workspaceId}:tab:${tabId}:image`;
}

/** An image tab's view, which the viewer, its header controls and the status bar share. */
export function useImage(workspaceId: string, tabId: string): [ImageState, (next: ImageState | ((v: ImageState) => ImageState)) => void] {
  return useKept<ImageState>(keyOf(workspaceId, tabId), INITIAL);
}

export function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

function quarter(turns: number): number {
  return ((turns % 4) + 4) % 4;
}

/** The next of ＋'s steps past `scale`, or with `dir` −1 the one before it. */
function step(scale: number, dir: 1 | -1): number {
  const next = dir > 0 ? STEPS.find((s) => s > scale * 1.001) : [...STEPS].reverse().find((s) => s < scale / 1.001);
  return next ?? (dir > 0 ? MAX : MIN);
}

function zoomed(v: ImageState, scale: number): ImageState {
  return { ...v, fit: false, scale: Math.min(MAX, Math.max(MIN, scale)), back: null };
}

/**
 * Mirrored across the screen's vertical axis, or its horizontal one. A
 * picture turned a quarter has its own axes the other way round, so it
 * mirrors along the other one, and a turn after it still turns clockwise.
 */
function flipped(v: ImageState, horizontally: boolean): ImageState {
  return horizontally === (quarter(v.turns) % 2 === 0) ? { ...v, flipX: !v.flipX, back: null } : { ...v, flipY: !v.flipY, back: null };
}

/** A double-click: fitted to actual size, actual size to double, and the next one back (IMG-03a). */
function toggled(v: ImageState): ImageState {
  if (v.back && !v.fit && v.scale === v.back.to) return { ...v, fit: v.back.fit, scale: v.back.scale, back: null };
  const to = Math.abs(v.scale - 1) < 0.005 ? 2 : 1;
  return { ...v, fit: false, scale: to, back: { fit: v.fit, scale: v.scale, to } };
}

function same(a: ImageState, b: ImageState): boolean {
  return a.fit === b.fit && a.scale === b.scale && a.turns === b.turns && a.flipX === b.flipX && a.flipY === b.flipY;
}

/** One of the viewer's controls: a header button or a row of its `⋯` menu, and a key. */
interface Control {
  label: string;
  key?: string;
  icon?: IconName;
  text?: string;
  act: (v: ImageState) => ImageState;
}

const ZOOM_OUT: Control = { label: "Zoom out", key: "−", icon: "zoomOut", act: (v) => zoomed(v, step(v.scale, -1)) };
const ZOOM_IN: Control = { label: "Zoom in", key: "+", icon: "zoomIn", act: (v) => zoomed(v, step(v.scale, 1)) };
/** What moves into the `⋯` menu when the header row is short of room (IMG-12). */
const FOLDING: Control[] = [
  { label: "Fit", key: "0", icon: "fit", act: (v) => ({ ...v, fit: true, back: null }) },
  { label: "Actual size", key: "1", text: "1:1", act: (v) => zoomed(v, 1) },
  { label: "Rotate left", key: "Shift+R", icon: "rotateLeft", act: (v) => ({ ...v, turns: v.turns - 1, back: null }) },
  { label: "Rotate right", key: "R", icon: "rotateRight", act: (v) => ({ ...v, turns: v.turns + 1, back: null }) },
  { label: "Flip horizontally", icon: "flipH", act: (v) => flipped(v, true) },
  { label: "Flip vertically", icon: "flipV", act: (v) => flipped(v, false) },
];
const [FIT, ACTUAL, LEFT, RIGHT] = FOLDING;

/** The control a key on the focused viewer asks for (IMG-02, IMG-03, IMG-05). */
function controlFor(e: React.KeyboardEvent): Control | null {
  if (e.altKey || e.metaKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "+" || key === "=") return ZOOM_IN;
  if (key === "-") return ZOOM_OUT;
  if (key === "0") return FIT;
  if (e.ctrlKey) return null;
  if (key === "1") return ACTUAL;
  if (key === "r") return e.shiftKey ? LEFT : RIGHT;
  return null;
}

/** A fraction across the drawn picture, as a fraction across the picture itself, turned `q` quarters and mirrored by `v`. */
function unturned([x, y]: [number, number], q: number, v: ImageState): [number, number] {
  const [a, b] = ([[x, y], [y, 1 - x], [1 - x, 1 - y], [1 - y, x]] as const)[q];
  return [v.flipX ? 1 - a : a, v.flipY ? 1 - b : b];
}

/** And back: a fraction across the picture itself, as a fraction across it drawn. */
function turned([a0, b0]: [number, number], q: number, v: ImageState): [number, number] {
  const a = v.flipX ? 1 - a0 : a0;
  const b = v.flipY ? 1 - b0 : b0;
  return ([[a, b], [1 - b, a], [1 - a, 1 - b], [b, 1 - a]] as const)[q] as [number, number];
}

/** Where the picture was laid out: what the next change is carried from. */
interface Shape {
  view: ImageState;
  scale: number;
  /** The picture's box as turned, and where it sits on the stage. */
  bw: number;
  bh: number;
  left: number;
  top: number;
  /** The viewer's own size. */
  w: number;
  h: number;
}

/**
 * An image tab's picture. A click gives it the keyboard, and the header's
 * controls change what it keeps and leave the keyboard where it is (IMG-11b).
 */
export function ImageView({ ws, tab, stamp }: { ws: Workspace; tab: EditorTab; stamp: string | null }) {
  const key = keyOf(ws.id, tab.id);
  const [view, setView] = useImage(ws.id, tab.id);
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const shown = useRef<Shape | null>(null);
  /** The scroll offsets, as last seen: a smaller stage has clamped them by the time a change is laid out. */
  const pos = useRef({ x: 0, y: 0 });
  /** The point a zoom holds still, in the viewer: the pointer's for a wheel or a double-click, else the middle. */
  const anchor = useRef<{ x: number; y: number } | null>(null);
  /** A wheel zoom follows the wheel; a button, a key or a double-click animates (IMG-11). */
  const direct = useRef(false);

  // The version in the address, so a rewritten file is fetched again and
  // another tab's older copy is never drawn from the cache; the asset
  // protocol reads the path alone.
  const url = stamp === null ? null : `${convertFileSrc(`${ws.path}/${tab.path}`)}?v=${encodeURIComponent(stamp)}`;
  const q = quarter(view.turns);
  const rw = q % 2 ? view.height : view.width;
  const rh = q % 2 ? view.width : view.height;
  const ready = !!box && view.width > 0 && url !== null && failed !== url;
  // Fitting never enlarges (IMG-01).
  const scale = ready && view.fit ? Math.max(0.01, Math.min(1, (box.w - 2 * MARGIN) / rw, (box.h - 2 * MARGIN) / rh)) : view.scale;
  const bw = rw * scale;
  const bh = rh * scale;
  const left = box ? Math.max(0, (box.w - bw) / 2) : 0;
  const top = box ? Math.max(0, (box.h - bh) / 2) : 0;

  /** Records where the view is scrolled, and the picture's point at its middle for a rebuilt view to go back to (IMG-07). */
  const record = () => {
    const el = scroller.current;
    const s = shown.current;
    if (!el) return;
    pos.current = { x: el.scrollLeft, y: el.scrollTop };
    if (s) keep(`${key}-at`, { u: (el.scrollLeft + s.w / 2 - s.left) / s.bw, v: (el.scrollTop + s.h / 2 - s.top) / s.bh });
  };

  /** A change the viewer made itself, anchored and timed as the input asks. */
  const change = (next: ImageState, at: { x: number; y: number } | null, animated: boolean) => {
    const now = peek<ImageState>(key);
    if (!now?.width || same(now, next)) return;
    anchor.current = at;
    direct.current = !animated;
    setView(next);
  };

  // A divider resizes the group as often as the window does.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // Hidden behind a panel it measures nothing, and keeps what it had.
      if (w > 0 && h > 0) setBox((b) => (b?.w === w && b.h === h ? b : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (editors.takeFocus(tab.id)) scroller.current?.focus({ preventScroll: true });
  }, [tab.id]);

  // Every change keeps a point of the picture where it was: the one under the
  // pointer for a wheel or a double-click, the middle of the view for the
  // rest, turned and mirrored with the picture. A button, a key or a
  // double-click then plays from how it looked to how it is now.
  useLayoutEffect(() => {
    const at = anchor.current;
    const animated = !direct.current;
    anchor.current = null;
    direct.current = false;
    const el = scroller.current;
    if (!el || !box || !ready) {
      shown.current = null;
      return;
    }
    // While fitted, the scale worked out here is the one the header and the status bar show.
    if (view.fit && view.scale !== scale) setView((v) => (v.fit ? { ...v, scale } : v));
    const now: Shape = { view, scale, bw, bh, left, top, w: box.w, h: box.h };
    const was = shown.current;
    shown.current = now;
    // Rounded here, not cut short by the webview, so a view rebuilt again and again stays where it was.
    const scrollTo = (x: number, y: number) => {
      el.scrollLeft = Math.round(x);
      el.scrollTop = Math.round(y);
      record();
    };
    if (!was) {
      const c = peek<{ u: number; v: number }>(`${key}-at`) ?? { u: 0.5, v: 0.5 };
      scrollTo(left + c.u * bw - box.w / 2, top + c.v * bh - box.h / 2);
      return;
    }
    if (was.bw === bw && was.bh === bh && was.w === box.w && was.h === box.h && was.view.turns === view.turns && was.view.flipX === view.flipX && was.view.flipY === view.flipY) return;
    const from = at ?? { x: was.w / 2, y: was.h / 2 };
    const to = at ?? { x: box.w / 2, y: box.h / 2 };
    const picture = unturned([(pos.current.x + from.x - was.left) / was.bw, (pos.current.y + from.y - was.top) / was.bh], quarter(was.view.turns), was.view);
    const [u, v] = turned(picture, q, view);
    const before = { x: was.left - pos.current.x + was.bw / 2, y: was.top - pos.current.y + was.bh / 2 };
    scrollTo(left + u * bw - to.x, top + v * bh - to.y);
    const f = frame.current;
    if (!f) return;
    // A turn or a zoom still under way is taken from where it has got to
    // (design-motion, Interruption); an input followed directly ends it.
    const current = getComputedStyle(f).transform;
    f.getAnimations().forEach((a) => a.cancel());
    // Only what the reader asked for plays, never a fit following a divider.
    // Scale and rotation have no distance to zero, so under reduced motion
    // they do not play at all.
    const asked = was.view.fit !== view.fit || (!view.fit && was.view.scale !== view.scale) || was.view.turns !== view.turns;
    if (!asked || !animated || reduce.matches) return;
    const dx = before.x - (left - el.scrollLeft + bw / 2);
    const dy = before.y - (top - el.scrollTop + bh / 2);
    f.animate(
      [{ transform: `translate(${dx}px, ${dy}px) ${current === "none" ? "" : current} rotate(${(was.view.turns - view.turns) * 90}deg) scale(${was.scale / scale})` }, { transform: "none" }],
      { duration: duration("--d-base"), easing: easing("--e-in-out") },
    );
  }, [box, ready, scale, bw, bh, view.turns, view.flipX, view.flipY, view.fit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Taken here, before wheel.ts and the webview see it: Ctrl zooms the
  // picture and never the page (IMG-02a), and Shift pans sideways (IMG-04).
  // A plain wheel is left to wheel.ts, which glides the viewer as it glides
  // every scroller (IMG-11). React's own listener is passive, and cannot.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const dy = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      if (e.ctrlKey) {
        e.preventDefault();
        const v = peek<ImageState>(key);
        const r = el.getBoundingClientRect();
        if (v) change(zoomed(v, v.scale * WHEEL_RATE ** (-dy / 100)), { x: e.clientX - r.left, y: e.clientY - r.top }, false);
      } else if (e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += dy;
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // A drag pans with the pointer, written straight to the scroller (IMG-04).
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (e.button !== 0 || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)) return;
    frame.current?.getAnimations().forEach((a) => a.finish());
    el.setPointerCapture(e.pointerId);
    const from = { x: e.clientX + el.scrollLeft, y: e.clientY + el.scrollTop };
    setGrabbing(true);
    const move = (m: PointerEvent) => {
      el.scrollLeft = from.x - m.clientX;
      el.scrollTop = from.y - m.clientY;
    };
    const up = () => {
      setGrabbing(false);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const arrow = ARROWS[e.key];
    if (arrow && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.currentTarget.scrollBy(arrow[0] * ARROW_PX, arrow[1] * ARROW_PX);
      return;
    }
    const control = controlFor(e);
    const v = peek<ImageState>(key);
    if (!control || !v) return;
    e.preventDefault();
    change(control.act(v), null, true);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = peek<ImageState>(key);
    const r = e.currentTarget.getBoundingClientRect();
    if (v) change(toggled(v), { x: e.clientX - r.left, y: e.clientY - r.top }, true);
  };

  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    // Measured on a copy that is never laid out: WebKit reports an SVG's
    // natural size as the size it is drawn at, and a kept view draws it at its
    // zoom before it loads, so every remount or reload would grow it (IMG-07).
    const img = e.currentTarget;
    const src = img.src;
    const copy = new Image();
    copy.src = src;
    void copy.decode().catch(() => {}).then(() => {
      // A newer version of the file has loaded since, and measures itself.
      if (img.src !== src) return;
      // An SVG with no size of its own reports none; WebKit draws one at 300 × 150.
      const w = copy.naturalWidth || 300;
      const h = copy.naturalHeight || 150;
      setView((v) => (v.width === w && v.height === h ? v : { ...v, width: w, height: h }));
    });
  };

  const pannable = ready && (bw > box.w + 0.5 || bh > box.h + 0.5);
  const iw = view.width * scale;
  const ih = view.height * scale;
  return (
    <div
      ref={scroller}
      className={`image-view${pannable ? " pannable" : ""}${grabbing ? " grabbing" : ""}${scale > 1 ? " enlarged" : ""}`}
      data-viewer={tab.id}
      tabIndex={0}
      aria-label={tab.path}
      onScroll={record}
      onKeyDown={onKey}
      onPointerDown={drag}
      onDoubleClick={onDoubleClick}
      onDragStart={(e) => e.preventDefault()}
    >
      {url === null ? (
        <div className="binary-notice"><p>{tab.path} was deleted or moved on disk.</p></div>
      ) : failed === url ? (
        <div className="binary-notice">
          <p>Cannot show {tab.path}.</p>
          <button onClick={() => void api.openExternally(ws.id, tab.path).catch(report)}>Open with the default application</button>
        </div>
      ) : (
        <div className="image-stage" style={ready ? { width: Math.max(box.w, bw), height: Math.max(box.h, bh) } : undefined}>
          <div ref={frame} className="image-frame" style={ready ? { left, top, width: bw, height: bh } : undefined}>
            <img
              src={url}
              alt={tab.path}
              draggable={false}
              onLoad={onLoad}
              onError={() => setFailed(url)}
              // Sized to the zoom, so the picture is drawn at it; unsized
              // until its size is known, so it never spreads the stage.
              style={ready ? {
                left: (bw - iw) / 2,
                top: (bh - ih) / 2,
                width: iw,
                height: ih,
                transform: `rotate(${view.turns * 90}deg) scale(${view.flipX ? -1 : 1}, ${view.flipY ? -1 : 1})`,
              } : { width: 0, height: 0 }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The viewer's controls, at the right end of the header row. Short of room,
 * everything but the zoom folds into a `⋯` menu (IMG-12); every control keeps
 * its key on the viewer either way.
 */
export function ImageTools({ workspaceId, tabId, folded }: { workspaceId: string; tabId: string; folded: boolean }) {
  const [view, setView] = useImage(workspaceId, tabId);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { if (!folded) setMenu(null); }, [folded]);
  // Nothing to act on until the picture has loaded and its size is known.
  const act = (c: Control) => setView((v) => (v.width ? c.act(v) : v));
  const button = (c: Control) => (
    <button key={c.label} onClick={() => act(c)} title={c.key ? `${c.label} (${c.key})` : c.label} aria-label={c.label}>
      {c.icon ? <Icon name={c.icon} size={14} /> : c.text}
    </button>
  );
  return (
    <span className="image-tools">
      {button(ZOOM_OUT)}
      <span className="image-zoom" title="Zoom">{percent(view.scale)}</span>
      {button(ZOOM_IN)}
      {folded ? (
        <button
          title="More"
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu(menu ? null : { x: r.left, y: r.bottom + 2 });
          }}
        >
          ⋯
        </button>
      ) : FOLDING.map(button)}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu} onClose={() => setMenu(null)}>
          {FOLDING.map((c) => (
            <button key={c.label} onClick={() => { act(c); setMenu(null); }}>
              <span className="menu-label">{c.label}</span>
              {c.key && <span className="menu-hint">{c.key}</span>}
            </button>
          ))}
        </ContextMenu>
      )}
    </span>
  );
}
