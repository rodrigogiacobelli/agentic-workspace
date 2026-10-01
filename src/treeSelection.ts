// The selection of one tree panel — the Explorer's, or the Custom panel's —
// as rules over the rows the panel draws. Which rows a click, a key or a
// delete leaves highlighted decides which files Delete, a move and a copy
// take, and a wrong answer there is a file trashed without a word once the
// question is off (SET-05). So the rules live here, apart from the drawing.

/**
 * A row as its panel draws it. `path` names the file; `key` names the row,
 * which in a view is not the same thing: a view draws a file twice when it
 * holds both the file and a folder above it, and a range runs from the copy
 * clicked (TREE-23a).
 */
export interface Row {
  key: string;
  path: string;
}

export interface Selection {
  /** The highlighted paths; a path drawn twice is highlighted at both copies. */
  set: ReadonlySet<string>;
  /**
   * The row the keyboard is on: a row's key, or a bare path. Either stands
   * for the first row drawing its path while no row has it as its key — a
   * bare path always, a view's copy once it is folded away.
   */
  lead: string | null;
  /** Where a Shift range starts, named as the lead is. */
  anchor: string | null;
}

export const NONE: Selection = { set: new Set(), lead: null, anchor: null };

/** The row a key names, or else the first drawing the path it carries; -1 when none is drawn. */
export function indexOf(rows: readonly Row[], name: string | null): number {
  if (name === null) return -1;
  const exact = rows.findIndex((r) => r.key === name);
  const path = pathOf(name);
  return exact !== -1 ? exact : rows.findIndex((r) => r.path === path);
}

/** The path a lead or an anchor names. A view's row keys are `<entry>\0<path>`; a NUL is in no path. */
export function pathOf(name: string): string {
  return name.slice(name.indexOf("\0") + 1);
}

/** One row alone: a plain click, an arrow key, a follow, a reveal. It is the anchor too. */
export function only(row: Row): Selection {
  return { set: new Set([row.path]), lead: row.key, anchor: row.key };
}

/**
 * Ctrl+click on row `i` (TREE-22): a row out of the selection comes in and
 * leads; one in it goes out, and the lead moves to the nearest selected row
 * above it, else below it, else nowhere. Either way the row is the anchor.
 */
export function toggle(sel: Selection, rows: readonly Row[], i: number): Selection {
  const row = rows[i];
  const set = new Set(sel.set);
  if (!set.delete(row.path)) return { set: set.add(row.path), lead: row.key, anchor: row.key };
  let lead: string | null = null;
  for (let j = i - 1; j >= 0 && lead === null; j--) if (set.has(rows[j].path)) lead = rows[j].key;
  for (let j = i + 1; j < rows.length && lead === null; j++) if (set.has(rows[j].path)) lead = rows[j].key;
  return { set, lead, anchor: row.key };
}

/**
 * Shift+click or Shift+arrow onto row `i` (TREE-23, TREE-24a): the rows
 * drawn from the anchor to it, in place of the selection, or added to it
 * with Ctrl. The anchor stays; an anchor no longer drawn gives way to the
 * lead, and with nothing selected the row comes alone.
 */
export function extend(sel: Selection, rows: readonly Row[], i: number, add: boolean): Selection {
  const from = sel.set.size ? [sel.anchor, sel.lead].map((n) => indexOf(rows, n)).find((j) => j !== -1) : undefined;
  if (from === undefined) return only(rows[i]);
  const set = new Set(add ? sel.set : []);
  for (let j = Math.min(from, i); j <= Math.max(from, i); j++) set.add(rows[j].path);
  return { set, lead: rows[i].key, anchor: rows[from].key };
}

/** Ctrl+A (TREE-24d): every row the panel draws, the lead kept where it is when drawn. */
export function all(sel: Selection, rows: readonly Row[]): Selection {
  if (!rows.length) return sel;
  const lead = indexOf(rows, sel.lead);
  return { set: new Set(rows.map((r) => r.path)), lead: rows[lead === -1 ? 0 : lead].key, anchor: sel.anchor };
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/**
 * The paths an operation takes from a selection: each once, and none inside
 * a folder that is taken itself, which carries it (TREE-25, TREE-26a).
 * Relative and absolute paths alike.
 */
export function outermost(paths: readonly string[]): string[] {
  const taken = new Set(paths);
  return [...taken].filter((p) => {
    for (let d = parentOf(p); d; d = parentOf(d)) if (taken.has(d)) return false;
    return true;
  });
}

/** A row as Delete weighs it. */
export interface Doomed extends Row {
  entry: { isDir: boolean; missing?: boolean };
  /** False where a filter draws the row, which draws a folder only on the way to its matches. */
  folds: boolean;
}

/**
 * What Delete does with the rows it takes (TREE-25, TREE-25a): those naming
 * one of a view's `entries` leave the view, and the rest go to the trash,
 * each once and a missing one never. A row inside a trashed folder goes with
 * the folder, and one beneath an entry that leaves stays on disk: a selection
 * acts once, as a move does (TREE-26a). A filtered
 * folder row taken with a row beneath it stands for the matches drawn there,
 * and is not trashed itself, so the files the filter hides stay.
 */
export function deleting<R extends Doomed>(rows: readonly R[], entries: readonly string[]): { leaving: R[]; going: R[] } {
  const leaving = rows.filter((r) => entries.includes(r.path));
  const standsIn = (r: R) => r.entry.isDir && !r.folds && rows.some((x) => x.path.startsWith(`${r.path}/`));
  const trashing = rows.filter((r) => !entries.includes(r.path) && !r.entry.missing && !standsIn(r));
  const outer = new Set(outermost([...leaving, ...trashing].map((r) => r.path)));
  return { leaving, going: trashing.filter((r) => outer.has(r.path)) };
}

/**
 * The row the selection moves to once `gone` leave the panel: the first
 * after the last row removed, else the last before the first one, else one
 * left between them; a row inside a removed folder goes with it (TREE-25).
 * Null when none is left.
 */
export function afterRemoval<R extends Row>(rows: readonly R[], gone: readonly string[]): R | null {
  const removed = (p: string) => gone.some((g) => p === g || p.startsWith(`${g}/`));
  const first = rows.findIndex((r) => removed(r.path));
  if (first === -1) return null;
  let last = first;
  rows.forEach((r, i) => { if (removed(r.path)) last = i; });
  return rows.slice(last + 1).find((r) => !removed(r.path)) ?? rows.slice(0, first).reverse().find((r) => !removed(r.path)) ?? rows.find((r) => !removed(r.path)) ?? null;
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** Whether a filter matches a file: its path holds the filter, inside one of a view's entries (`roots`) in a view. */
function matcher(filter: string, roots: readonly string[] | null): (file: string) => boolean {
  const needle = filter.toLowerCase();
  return (f) => (!roots || roots.some((r) => inside(f, r))) && f.toLowerCase().includes(needle);
}

/** The most files a filter draws: a short filter over a large tree would otherwise draw nearly all of it. */
const MATCHES_DRAWN = 2000;

/**
 * The files a filter draws, the first MATCHES_DRAWN it matches in the list's
 * order. The tree draws these and no others, so what a follow, a reveal and
 * a count of highlighted rows weigh is this too, not every match: a file past
 * the cap has no row.
 */
export function* matches(files: readonly string[], filter: string, roots: readonly string[] | null): Generator<string> {
  const hit = matcher(filter, roots);
  let n = 0;
  for (const f of files) {
    if (!hit(f)) continue;
    yield f;
    if (++n === MATCHES_DRAWN) return;
  }
}

/**
 * Which paths a panel draws, which decides whether the document in front is
 * selected there (§9.16, TREE-18 to TREE-20), how many rows a selection still
 * highlights (TREE-21) and whether a reveal clears the filter (ED-59). Under a
 * filter, a file it draws (`matches`) is the path or lies inside it; `files` is
 * the list the filter runs over, and until it is read the path's own name decides.
 * Otherwise every folder above the path is open, up to a top-level one in the
 * Explorer, or up to one of the view's entries (`roots`) in a view. The panel
 * is weighed once for any number of paths: a whole selection costs one pass
 * over the filter's list, not one per path (ADR-018).
 */
export function drawing(expanded: readonly string[], roots: readonly string[] | null, filter: string, files: readonly string[] | null): (path: string) => boolean {
  if (filter) {
    if (!files) return matcher(filter, roots);
    // Every match drawn and each folder above it. A folder already taken has
    // its own folders taken, so the walk up stops there.
    const shown = new Set<string>();
    for (const f of matches(files, filter, roots)) for (let d = f; d && !shown.has(d); d = parentOf(d)) shown.add(d);
    return (path) => shown.has(path);
  }
  const open = new Set(expanded);
  const openTo = (path: string, top: string) => {
    for (let d = parentOf(path); d !== top; d = parentOf(d)) if (!open.has(d)) return false;
    return top === "" || open.has(top);
  };
  return (path) => (roots ? roots.some((r) => path === r || (path.startsWith(`${r}/`) && openTo(path, r))) : openTo(path, ""));
}

/** `drawing` for one path, which under a filter walks the list only as far as a match inside it. */
export function draws(path: string, expanded: readonly string[], roots: readonly string[] | null, filter: string, files: readonly string[] | null): boolean {
  if (!filter || !files) return drawing(expanded, roots, filter, files)(path);
  for (const f of matches(files, filter, roots)) if (inside(f, path)) return true;
  return false;
}

/** Names for a question: up to five, then how many more (TREE-25). */
export function listed(names: readonly string[]): string {
  const shown = names.slice(0, 5).join("\n");
  return names.length > 5 ? `${shown}\nand ${names.length - 5} more` : shown;
}
