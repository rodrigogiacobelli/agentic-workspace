// The one layout mechanism for both the editor groups and the panel regions:
// a tree of rows and columns rendered with draggable dividers, and the drop
// zones — four edges and a centre — that a tab, a file or a panel lands on.

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

export type Direction = "row" | "column";

export interface SplitNode<L> {
  kind: "split";
  direction: Direction;
  children: TreeNode<L>[];
  sizes: number[];
}

export type TreeNode<L> = L | SplitNode<L>;

const MIN = 0.1;

interface TreeProps<L extends { kind: string }> {
  node: TreeNode<L>;
  /** Child indexes from the root, naming a split for `onResize`. */
  path: number[];
  keyOf: (leaf: L) => string;
  renderLeaf: (leaf: L, path: number[]) => ReactNode;
  onResize: (path: number[], sizes: number[]) => void;
}

function nodeKey<L extends { kind: string }>(node: TreeNode<L>, keyOf: (leaf: L) => string): string {
  return node.kind === "split" ? `split:${nodeKey((node as SplitNode<L>).children[0], keyOf)}` : keyOf(node as L);
}

export function SplitTree<L extends { kind: string }>({ node, path, keyOf, renderLeaf, onResize }: TreeProps<L>) {
  const container = useRef<HTMLDivElement>(null);
  const split = node.kind === "split" ? (node as SplitNode<L>) : null;
  const [sizes, setSizes] = useState<number[]>(split?.sizes ?? []);
  useEffect(() => { if (split) setSizes(split.sizes); }, [split?.sizes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!split) return <>{renderLeaf(node as L, path)}</>;

  const startDrag = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    const el = container.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const total = split.direction === "row" ? rect.width : rect.height;
    const origin = split.direction === "row" ? e.clientX : e.clientY;
    const start = [...sizes];
    let current = start;
    const pair = start[i] + start[i + 1];
    const move = (ev: MouseEvent) => {
      const delta = ((split.direction === "row" ? ev.clientX : ev.clientY) - origin) / total;
      const a = Math.min(pair - MIN, Math.max(MIN, start[i] + delta));
      current = [...start];
      current[i] = a;
      current[i + 1] = pair - a;
      setSizes(current);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      onResize(path, current);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div ref={container} className={`split split-${split.direction}`}>
      {split.children.map((child, i) => (
        <Fragment key={nodeKey(child, keyOf)}>
          {i > 0 && <div className={`divider divider-${split.direction}`} onMouseDown={startDrag(i - 1)} />}
          <div className="split-child" style={{ flex: `${sizes[i] ?? 1 / split.children.length} 1 0` }}>
            <SplitTree node={child} path={[...path, i]} keyOf={keyOf} renderLeaf={renderLeaf} onResize={onResize} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

// --- Drop zones --------------------------------------------------------------

export type Zone = "center" | "left" | "right" | "top" | "bottom";

interface ZoneOptions {
  /** Only the edges accept a drop; the centre resolves to the nearest edge. */
  edgesOnly?: boolean;
  /** A drop here is handled by a child instead; no zone is shown over it. */
  ignore?: (target: Element) => boolean;
}

/**
 * Turns an element into a drop target with five zones. `accepts` looks at the
 * drag's MIME types, since its data is unreadable until the drop.
 */
export function useDropZone(accepts: (types: readonly string[]) => boolean, onDrop: (zone: Zone, e: React.DragEvent) => void, options: ZoneOptions = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const [zone, setZone] = useState<Zone | null>(null);
  const depth = useRef(0);

  const compute = (e: React.DragEvent): Zone => {
    const r = ref.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    const band = 0.25;
    const inBand = x < band || x > 1 - band || y < band || y > 1 - band;
    if (!inBand && !options.edgesOnly) return "center";
    const edges: [Zone, number][] = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]];
    edges.sort((a, b) => a[1] - b[1]);
    return edges[0][0];
  };

  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!accepts(e.dataTransfer.types)) return;
      depth.current += 1;
    },
    onDragOver: (e: React.DragEvent) => {
      if (!accepts(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (options.ignore?.(e.target as Element)) { setZone(null); return; }
      const next = compute(e);
      setZone((z) => (z === next ? z : next));
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!accepts(e.dataTransfer.types)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setZone(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!accepts(e.dataTransfer.types)) return;
      depth.current = 0;
      setZone(null);
      if (options.ignore?.(e.target as Element)) return;
      e.preventDefault();
      e.stopPropagation();
      onDrop(compute(e), e);
    },
  };

  const overlay = zone ? <div className={`drop-zone drop-${zone}`} /> : null;
  return { ref, zone, handlers, overlay };
}

export const TAB_MIME = "application/x-agentic-tab";
export const FILE_MIME = "application/x-agentic-file";
export const PANEL_MIME = "application/x-agentic-panel";
