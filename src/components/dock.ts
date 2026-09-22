// The panel layout: where Files, Search, Git and Outline sit around the
// editor area. A tree of regions — each a tabbed stack of panels — and the
// editor leaf, which is never removed and never becomes a tab. The layout is
// the application's, not a workspace's (DOCK-08).

import type { DockLeaf, DockNode, PanelId, PanelLayout, Region } from "../types";
import type { SplitNode, Zone } from "./SplitTree";

export type { DockLeaf, DockNode, PanelId, PanelLayout, Region };

export const PANELS: { id: PanelId; label: string; hotkey: string }[] = [
  { id: "files", label: "Files", hotkey: "Ctrl+Shift+E" },
  { id: "search", label: "Search", hotkey: "Ctrl+Shift+F" },
  { id: "git", label: "Git", hotkey: "Ctrl+Shift+G" },
  { id: "outline", label: "Outline", hotkey: "Ctrl+Shift+O" },
];

let counter = 0;
function newId(): string {
  counter += 1;
  return `r${Date.now().toString(36)}${counter}`;
}

export function defaultLayout(): PanelLayout {
  return {
    root: {
      kind: "split",
      direction: "row",
      children: [{ kind: "region", id: "left", panels: ["files", "search", "git", "outline"], active: "files" }, { kind: "editor" }],
      sizes: [0.22, 0.78],
    },
    hidden: [],
    lastRegion: {},
  };
}

export function leafKey(leaf: DockLeaf): string {
  return leaf.kind === "editor" ? "editor" : leaf.id;
}

export function regions(node: DockNode): Region[] {
  if (node.kind === "region") return [node];
  if (node.kind === "split") return (node as SplitNode<DockLeaf>).children.flatMap(regions);
  return [];
}

export function regionOf(layout: PanelLayout, panel: PanelId): Region | undefined {
  return regions(layout.root).find((r) => r.panels.includes(panel));
}

/** Removes empty regions and one-child splits; guarantees the editor leaf. */
function collapse(node: DockNode): DockNode | null {
  if (node.kind === "region") return node.panels.length ? node : null;
  if (node.kind === "editor") return node;
  const split = node as SplitNode<DockLeaf>;
  const kept: { child: DockNode; size: number }[] = [];
  split.children.forEach((c, i) => {
    const child = collapse(c);
    if (child) kept.push({ child, size: split.sizes[i] ?? 1 / split.children.length });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;
  const total = kept.reduce((s, k) => s + k.size, 0) || 1;
  return { kind: "split", direction: split.direction, children: kept.map((k) => k.child), sizes: kept.map((k) => k.size / total) };
}

/** Repairs a layout read from the store: every panel once, or hidden. */
export function normalize(layout: PanelLayout): PanelLayout {
  const seen = new Set<PanelId>();
  const dedupe = (node: DockNode): DockNode => {
    if (node.kind === "region") {
      const panels = node.panels.filter((p) => PANELS.some((k) => k.id === p) && !seen.has(p));
      panels.forEach((p) => seen.add(p));
      return { ...node, panels, active: panels.includes(node.active) ? node.active : panels[0] };
    }
    if (node.kind === "split") return { ...node, children: (node as SplitNode<DockLeaf>).children.map(dedupe) };
    return node;
  };
  let root = collapse(dedupe(layout.root));
  const hasEditor = (n: DockNode): boolean => n.kind === "editor" || (n.kind === "split" && (n as SplitNode<DockLeaf>).children.some(hasEditor));
  if (!root || !hasEditor(root)) root = root ? { kind: "split", direction: "row", children: [root, { kind: "editor" }], sizes: [0.22, 0.78] } : { kind: "editor" };
  const hidden = layout.hidden.filter((p) => PANELS.some((k) => k.id === p) && !seen.has(p));
  return { root, hidden, lastRegion: layout.lastRegion ?? {} };
}

function withoutPanel(node: DockNode, panel: PanelId): DockNode {
  if (node.kind === "region") {
    const panels = node.panels.filter((p) => p !== panel);
    return { ...node, panels, active: node.active === panel ? panels[0] : node.active };
  }
  if (node.kind === "split") return { ...node, children: (node as SplitNode<DockLeaf>).children.map((c) => withoutPanel(c, panel)) };
  return node;
}

/** Wraps the leaf `key` in a split with a new region holding `panel` on `zone`'s side. */
function splitLeaf(node: DockNode, key: string, panel: PanelId, zone: Zone): DockNode {
  if (node.kind === "split") {
    const split = node as SplitNode<DockLeaf>;
    const direction = zone === "left" || zone === "right" ? "row" : "column";
    const i = split.children.findIndex((c) => c.kind !== "split" && leafKey(c as DockLeaf) === key);
    if (i >= 0 && split.direction === direction) {
      const fresh: Region = { kind: "region", id: newId(), panels: [panel], active: panel };
      const at = zone === "left" || zone === "top" ? i : i + 1;
      const children = [...split.children];
      const sizes = [...split.sizes];
      const share = sizes[i] * 0.3;
      sizes[i] -= share;
      children.splice(at, 0, fresh);
      sizes.splice(at, 0, share);
      return { ...split, children, sizes };
    }
    return { ...split, children: split.children.map((c) => splitLeaf(c, key, panel, zone)) };
  }
  if (leafKey(node as DockLeaf) !== key) return node;
  const fresh: Region = { kind: "region", id: newId(), panels: [panel], active: panel };
  const direction = zone === "left" || zone === "right" ? "row" : "column";
  const first = zone === "left" || zone === "top";
  const sizes = node.kind === "editor" ? (first ? [0.25, 0.75] : [0.75, 0.25]) : [0.5, 0.5];
  return { kind: "split", direction, children: first ? [fresh, node] : [node, fresh], sizes };
}

function addToRegion(node: DockNode, regionId: string, panel: PanelId): DockNode {
  if (node.kind === "region") return node.id === regionId ? { ...node, panels: [...node.panels, panel], active: panel } : node;
  if (node.kind === "split") return { ...node, children: (node as SplitNode<DockLeaf>).children.map((c) => addToRegion(c, regionId, panel)) };
  return node;
}

/** A panel dropped on a leaf: its centre tabs it there, an edge makes a new region (DOCK-02 to DOCK-06). */
export function dropPanel(layout: PanelLayout, panel: PanelId, targetKey: string, zone: Zone): PanelLayout {
  const source = regionOf(layout, panel);
  // Alone in the region it was dropped on: there is nowhere else for it to go.
  if (source && source.id === targetKey && source.panels.length === 1) return layout;
  let root = collapse(withoutPanel(layout.root, panel)) ?? { kind: "editor" };
  if (targetKey !== "editor" && !regions(root).some((r) => r.id === targetKey)) return layout;
  root = zone === "center" && targetKey !== "editor" ? addToRegion(root, targetKey, panel) : splitLeaf(root, targetKey, panel, zone);
  return normalize({ root, hidden: layout.hidden.filter((p) => p !== panel), lastRegion: layout.lastRegion });
}

export function setActivePanel(layout: PanelLayout, regionId: string, panel: PanelId): PanelLayout {
  const walk = (node: DockNode): DockNode => {
    if (node.kind === "region") return node.id === regionId && node.panels.includes(panel) ? { ...node, active: panel } : node;
    if (node.kind === "split") return { ...node, children: (node as SplitNode<DockLeaf>).children.map(walk) };
    return node;
  };
  return { ...layout, root: walk(layout.root) };
}

export function hidePanel(layout: PanelLayout, panel: PanelId): PanelLayout {
  const region = regionOf(layout, panel);
  if (!region) return layout;
  return normalize({
    root: withoutPanel(layout.root, panel),
    hidden: [...layout.hidden, panel],
    lastRegion: { ...layout.lastRegion, [panel]: region.id },
  });
}

/** Brings a panel back where it was, or into the first region, and makes it active (DOCK-09, DOCK-10). */
export function showPanel(layout: PanelLayout, panel: PanelId): PanelLayout {
  const existing = regionOf(layout, panel);
  if (existing) return setActivePanel(layout, existing.id, panel);
  const all = regions(layout.root);
  const home = all.find((r) => r.id === layout.lastRegion[panel]) ?? all[0];
  const root = home ? addToRegion(layout.root, home.id, panel) : splitLeaf(layout.root, "editor", panel, "left");
  return normalize({ root, hidden: layout.hidden.filter((p) => p !== panel), lastRegion: layout.lastRegion });
}

export function resizeSplit(layout: PanelLayout, path: number[], sizes: number[]): PanelLayout {
  const walk = (node: DockNode, rest: number[]): DockNode => {
    if (node.kind !== "split") return node;
    const split = node as SplitNode<DockLeaf>;
    if (rest.length === 0) return sizes.length === split.children.length ? { ...split, sizes } : split;
    const [i, ...tail] = rest;
    return { ...split, children: split.children.map((c, j) => (j === i ? walk(c, tail) : c)) };
  };
  return { ...layout, root: walk(layout.root, path) };
}
