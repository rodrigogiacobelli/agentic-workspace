// The dock: where each mode's panels sit around its working area. One tree per
// docked mode, of regions — each a tabbed stack of panels — and the work leaf,
// which is never removed and takes a panel dropped on its centre as one of its
// own tabs. A panel belongs to one mode and appears only in that mode's tree.
// The trees are the application's, not a workspace's (DOCK-08).

import type { DockedMode, DockLeaf, DockNode, PanelId, PanelLayout, PanelLayouts, Region, WorkLeaf } from "../types";
import type { IconName } from "./icons";
import type { SplitNode, Zone } from "./SplitTree";

export type { DockLeaf, DockNode, PanelId, PanelLayout, Region };

export interface PanelInfo {
  id: PanelId;
  mode: DockedMode;
  label: string;
  icon: IconName;
  hotkey?: string;
}

export const PANELS: PanelInfo[] = [
  { id: "explorer", mode: "editor", label: "Explorer", icon: "folder", hotkey: "Ctrl+Shift+E" },
  { id: "custom", mode: "editor", label: "Custom", icon: "custom" },
  { id: "search", mode: "editor", label: "Search", icon: "search", hotkey: "Ctrl+Shift+F" },
  { id: "outline", mode: "editor", label: "Outline", icon: "outline", hotkey: "Ctrl+Shift+O" },
  { id: "commit", mode: "scm", label: "Commit", icon: "commit", hotkey: "Ctrl+Shift+G" },
  { id: "history", mode: "scm", label: "History", icon: "history" },
  { id: "branches", mode: "scm", label: "Branches", icon: "git" },
  { id: "worktrees", mode: "scm", label: "Worktrees", icon: "worktrees" },
  { id: "tags", mode: "scm", label: "Tags", icon: "tag" },
];

export function panelInfo(id: PanelId): PanelInfo | undefined {
  return PANELS.find((p) => p.id === id);
}

export function panelsOf(mode: DockedMode): PanelInfo[] {
  return PANELS.filter((p) => p.mode === mode);
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `r${Date.now().toString(36)}${counter}`;
}

const WORK: WorkLeaf = { kind: "work", panels: [], active: null };

/**
 * No strip holds more than three tabs, so labels fit at every width. The
 * Editor puts the file panels left and the outline right; Source Control puts
 * Commit left, History down the right — a timeline reads as a tall list — and
 * the ref lists under the working area.
 */
export function defaultLayout(mode: DockedMode): PanelLayout {
  const root: DockNode = mode === "editor"
    ? {
        kind: "split",
        direction: "row",
        children: [
          { kind: "region", id: "left", panels: ["explorer", "custom", "search"], active: "explorer" },
          WORK,
          { kind: "region", id: "right", panels: ["outline"], active: "outline" },
        ],
        sizes: [0.19, 0.64, 0.17],
      }
    : {
        kind: "split",
        direction: "row",
        children: [
          { kind: "region", id: "left", panels: ["commit"], active: "commit" },
          {
            kind: "split",
            direction: "column",
            children: [WORK, { kind: "region", id: "below", panels: ["branches", "worktrees", "tags"], active: "branches" }],
            sizes: [0.66, 0.34],
          },
          { kind: "region", id: "right", panels: ["history"], active: "history" },
        ],
        sizes: [0.21, 0.58, 0.21],
      };
  return { root, hidden: [], lastRegion: {} };
}

export function leafKey(leaf: DockLeaf): string {
  return leaf.kind === "work" ? "work" : leaf.id;
}

/** Every leaf that holds panels: the regions, and the work leaf. */
function holders(node: DockNode): (Region | WorkLeaf)[] {
  if (node.kind === "split") return (node as SplitNode<DockLeaf>).children.flatMap(holders);
  return [node];
}

export function regions(node: DockNode): Region[] {
  return holders(node).filter((l): l is Region => l.kind === "region");
}

/** The leaf a panel is in, by its key: a region's id, or `work`. */
export function holderOf(layout: PanelLayout, panel: PanelId): { key: string; panels: PanelId[] } | undefined {
  const leaf = holders(layout.root).find((l) => l.panels.includes(panel));
  return leaf && { key: leafKey(leaf), panels: leaf.panels };
}

/** Removes empty regions and one-child splits; the work leaf always stays. */
function collapse(node: DockNode): DockNode | null {
  if (node.kind === "region") return node.panels.length ? node : null;
  if (node.kind === "work") return node;
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

/**
 * Repairs one mode's layout read from the store: every panel of the mode once,
 * in the tree or hidden, and nothing from another mode. A panel the tree does
 * not name — one added since the layout was stored — joins the hidden ones, so
 * the View menu offers it rather than claiming it is shown.
 */
export function normalize(layout: PanelLayout, mode: DockedMode): PanelLayout {
  const own = new Set(panelsOf(mode).map((p) => p.id));
  const seen = new Set<PanelId>();
  const keep = (panels: PanelId[]) => {
    const out = panels.filter((p) => own.has(p) && !seen.has(p));
    out.forEach((p) => seen.add(p));
    return out;
  };
  const dedupe = (node: DockNode): DockNode => {
    if (node.kind === "region") {
      const panels = keep(node.panels ?? []);
      return { ...node, panels, active: panels.includes(node.active) ? node.active : panels[0] };
    }
    if (node.kind === "split") return { ...node, children: (node as SplitNode<DockLeaf>).children.map(dedupe) };
    const panels = keep((node as WorkLeaf).panels ?? []);
    const active = (node as WorkLeaf).active;
    return { kind: "work", panels, active: active && panels.includes(active) ? active : null };
  };
  let root = collapse(dedupe(layout.root));
  const hasWork = (n: DockNode): boolean => n.kind === "work" || (n.kind === "split" && (n as SplitNode<DockLeaf>).children.some(hasWork));
  if (!root || !hasWork(root)) root = root ? { kind: "split", direction: "row", children: [root, { ...WORK }], sizes: [0.22, 0.78] } : { ...WORK };
  const hidden = (layout.hidden ?? []).filter((p) => own.has(p) && !seen.has(p));
  hidden.forEach((p) => seen.add(p));
  for (const p of own) if (!seen.has(p)) hidden.push(p);
  return { root, hidden, lastRegion: layout.lastRegion ?? {} };
}

/**
 * The layout written before modes was one tree for the whole application,
 * holding Files, Search, Git and Outline around an editor leaf. It becomes the
 * Editor's tree: Files is Explorer with Custom beside it, Git leaves for
 * Source Control, and the editor leaf is the work leaf.
 */
function fromSingleTree(old: { root: unknown; hidden?: unknown; lastRegion?: unknown }): PanelLayout {
  const rename = (panels: unknown): PanelId[] =>
    (Array.isArray(panels) ? panels : []).flatMap((p) => (p === "files" ? ["explorer", "custom"] : p === "git" ? [] : [p])) as PanelId[];
  const walk = (node: any): DockNode => {
    if (node?.kind === "split") return { ...node, children: (node.children ?? []).map(walk) };
    if (node?.kind === "region") {
      const panels = rename(node.panels);
      const active = node.active === "files" ? "explorer" : node.active;
      return { kind: "region", id: String(node.id), panels, active: panels.includes(active) ? active : panels[0] };
    }
    return { ...WORK };
  };
  const last: Partial<Record<PanelId, string>> = {};
  for (const [panel, region] of Object.entries((old.lastRegion ?? {}) as Record<string, string>)) {
    for (const p of rename([panel])) last[p] = region;
  }
  return { root: walk(old.root), hidden: rename(old.hidden), lastRegion: last };
}

/** Every docked mode's layout from what the store holds: null, the old single tree, or one tree per mode. */
export function normalizeAll(stored: unknown): PanelLayouts {
  const value = (stored ?? {}) as Record<string, unknown>;
  const byMode: Partial<Record<DockedMode, unknown>> = "root" in value ? { editor: fromSingleTree(value as never) } : value;
  const one = (mode: DockedMode): PanelLayout => {
    const l = byMode[mode] as PanelLayout | undefined;
    return normalize(l?.root ? l : defaultLayout(mode), mode);
  };
  return { editor: one("editor"), scm: one("scm") };
}

function withoutPanel(node: DockNode, panel: PanelId): DockNode {
  if (node.kind === "region") {
    const panels = node.panels.filter((p) => p !== panel);
    return { ...node, panels, active: node.active === panel ? panels[0] : node.active };
  }
  if (node.kind === "work") {
    return { ...node, panels: node.panels.filter((p) => p !== panel), active: node.active === panel ? null : node.active };
  }
  return { ...node, children: (node as SplitNode<DockLeaf>).children.map((c) => withoutPanel(c, panel)) };
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
  const sizes = node.kind === "work" ? (first ? [0.25, 0.75] : [0.75, 0.25]) : [0.5, 0.5];
  return { kind: "split", direction, children: first ? [fresh, node] : [node, fresh], sizes };
}

/** Puts a panel last in a leaf's tabs — a region's strip, or the working area's — and makes it active. */
function addToLeaf(node: DockNode, key: string, panel: PanelId): DockNode {
  if (node.kind === "split") return { ...node, children: (node as SplitNode<DockLeaf>).children.map((c) => addToLeaf(c, key, panel)) };
  if (leafKey(node) !== key) return node;
  return { ...node, panels: [...node.panels, panel], active: panel } as DockLeaf;
}

/**
 * A panel dropped on a leaf: an edge makes a new region beside it, and the
 * centre joins its tabs — a region's, or the working area's, where the panel
 * becomes a tab beside the files or the diffs (DOCK-02 to DOCK-06).
 */
export function dropPanel(layout: PanelLayout, panel: PanelId, targetKey: string, zone: Zone): PanelLayout {
  const source = holderOf(layout, panel);
  // Alone in the region it was dropped on: there is nowhere else for it to go.
  if (source && source.key === targetKey && targetKey !== "work" && source.panels.length === 1) return layout;
  if (source && source.key === targetKey && zone === "center") return layout;
  let root = collapse(withoutPanel(layout.root, panel)) ?? { ...WORK };
  if (targetKey !== "work" && !regions(root).some((r) => r.id === targetKey)) return layout;
  root = zone === "center" ? addToLeaf(root, targetKey, panel) : splitLeaf(root, targetKey, panel, zone);
  return { root, hidden: layout.hidden.filter((p) => p !== panel), lastRegion: layout.lastRegion };
}

function mapLeaf(node: DockNode, key: string, f: (l: Region | WorkLeaf) => Region | WorkLeaf): DockNode {
  if (node.kind === "split") return { ...node, children: (node as SplitNode<DockLeaf>).children.map((c) => mapLeaf(c, key, f)) };
  return leafKey(node) === key ? f(node) : node;
}

/** Shows a panel of a leaf; for the work leaf, null shows its files or diffs again. */
export function setActivePanel(layout: PanelLayout, key: string, panel: PanelId | null): PanelLayout {
  return {
    ...layout,
    root: mapLeaf(layout.root, key, (l) => {
      if (l.kind === "work") return { ...l, active: panel && l.panels.includes(panel) ? panel : null };
      return panel && l.panels.includes(panel) ? { ...l, active: panel } : l;
    }),
  };
}

/**
 * Puts a panel at a position in a leaf's tab strip — before the tab at
 * `index`, or last — moving it from wherever it was, and makes it active.
 */
export function placePanel(layout: PanelLayout, panel: PanelId, key: string, index: number | null): PanelLayout {
  const target = holders(layout.root).find((l) => leafKey(l) === key);
  if (!target) return layout;
  const from = target.panels.indexOf(panel);
  const rest = target.panels.filter((p) => p !== panel);
  const at = index === null ? rest.length : Math.min(from >= 0 && index > from ? index - 1 : index, rest.length);
  const panels = [...rest];
  panels.splice(at, 0, panel);
  const root = collapse(mapLeaf(withoutPanel(layout.root, panel), key, (l) => ({ ...l, panels, active: panel }) as Region | WorkLeaf)) ?? { ...WORK };
  return { root, hidden: layout.hidden.filter((p) => p !== panel), lastRegion: layout.lastRegion };
}

export function hidePanel(layout: PanelLayout, panel: PanelId): PanelLayout {
  const holder = holderOf(layout, panel);
  if (!holder) return layout;
  return {
    root: collapse(withoutPanel(layout.root, panel)) ?? { ...WORK },
    hidden: [...layout.hidden, panel],
    lastRegion: { ...layout.lastRegion, [panel]: holder.key },
  };
}

/** Brings a panel back where it was, or into the first region, and makes it active (DOCK-09, DOCK-10). */
export function showPanel(layout: PanelLayout, panel: PanelId): PanelLayout {
  const existing = holderOf(layout, panel);
  if (existing) return setActivePanel(layout, existing.key, panel);
  const last = layout.lastRegion[panel];
  const all = regions(layout.root);
  const home = last === "work" ? "work" : (all.find((r) => r.id === last) ?? all[0])?.id;
  const root = home ? addToLeaf(layout.root, home, panel) : splitLeaf(layout.root, "work", panel, "left");
  return { root, hidden: layout.hidden.filter((p) => p !== panel), lastRegion: layout.lastRegion };
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
