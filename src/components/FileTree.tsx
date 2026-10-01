import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, events } from "../api";
import { offerDrop, onDropEnd, startTreeDrag, treeDrag, type DropAction, type TreeDrag } from "../dropRoute";
import * as editors from "../editors";
import { keep, peek, put, useKept, useKeptScroll, useLive } from "../live";
import * as settings from "../settings";
import * as selection from "../treeSelection";
import type { Entry, StatusEntry, View, Workspace } from "../types";
import { Confirm } from "./Confirm";
import { fileIcon, Icon } from "./icons";
import { ContextMenu, RowMenu, SubMenu } from "./Menu";
import { Prompt } from "./Prompt";
import { FILE_MIME } from "./SplitTree";
import { duration } from "../motion";
import { report } from "../notice";

/** The workspace's own tree, or its custom views. */
type Kind = "explorer" | "custom";

interface Props {
  ws: Workspace;
  kind: Kind;
  /** A single click opens a preview tab; a double click or a new file opens a permanent one. */
  onOpen: (path: string, preview: boolean) => void;
  /** Inserts a citation of each path into the active document, one per line. */
  onQuote: (paths: string[]) => void;
  gitStatus?: StatusEntry[];
}

/** One letter per path, and a summary letter for every ancestor directory. */
function statusMap(status: StatusEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of status) {
    const letter = s.conflicted ? "!" : s.untracked ? "U" : s.index !== "." ? s.index : s.worktree;
    map.set(s.path, letter);
    const parts = s.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const prev = map.get(dir);
      if (prev === "!" ) continue;
      map.set(dir, letter === "!" ? "!" : prev === "U" || letter === "U" ? "U" : "M");
    }
  }
  return map;
}

/** A row as the tree last drew it: what the keys and every action of the panel work on (TREE-22a). */
interface TreeRow extends selection.Row {
  entry: Entry;
  /** Its branch is drawn open. */
  open: boolean;
  /** A click, ← and → fold and unfold it; a filtered tree draws every folder open. */
  folds: boolean;
  /** The row is one of the open view's own entries. */
  viewRoot: boolean;
  /** The row whose branch it is drawn in, by its place in the order; -1 at the top. */
  parent: number;
}

interface Menu {
  x: number;
  y: number;
  /** The row right-clicked; null for the background. */
  row: TreeRow | null;
}

type Dialog =
  | { kind: "new-file"; dir: string }
  | { kind: "new-folder"; dir: string }
  | { kind: "rename"; entry: Entry }
  | { kind: "new-view"; then?: string[] }
  | { kind: "rename-view"; view: View };

/** A question the tree asks in a dialog of its own, and the answer it waits on (SET-05a, TREE-27). */
interface Question {
  title: string;
  message: string;
  ok: string;
  cancel: string;
  alt?: string;
  checkbox?: { label: string };
  answer: (a: { ok: boolean; checked: boolean; alt: boolean }) => void;
}

/** A move made in the tree, which Ctrl+Z makes back (TREE-13). */
interface Move {
  from: string;
  to: string;
}

/** How many batches of moves Ctrl+Z can walk back through. */
const UNDO_DEPTH = 20;

/** A file URI as another application reads one: every segment percent-encoded. */
function fileUri(abs: string): string {
  return `file://${abs.split("/").map(encodeURIComponent).join("/")}`;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * The expanded directories a tree draws: those whose every ancestor is open
 * too, up to a top-level directory — or, in a view, up to one of its entries.
 * A directory left expanded inside a folded one is not drawn, and not read.
 */
function drawn(expanded: string[], roots: string[] | null): string[] {
  const open = new Set(expanded);
  const isRoot = (d: string) => (roots ? roots.includes(d) : !d.includes("/"));
  return expanded.filter((dir) => {
    for (let d = dir; open.has(d); d = dirOf(d)) if (isRoot(d)) return true;
    return false;
  });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Nothing listed yet. Never changed in place: a listing lands in a new map. */
const NOTHING = new Map<string, Entry[]>();

/**
 * Whether the desktop clipboard held files when last asked: one answer for
 * every tree, since the clipboard is the desktop's.
 */
let clipboardHasFiles: boolean | null = null;

/** Where each panel's selection is kept: one per panel, never shared (TREE-22). */
const selectionKey = (workspaceId: string, kind: Kind) => `${workspaceId}:tree:${kind}:selection`;

/** The view the Custom panel shows: the one last picked, or the first there is. */
const shownView = (ws: Workspace): View | null => ws.views.find((v) => v.id === ws.activeView) ?? ws.views[0] ?? null;

/**
 * Lead rows asked for from outside a tree, by a follow or a reveal, to be
 * scrolled into view once drawn, as `<workspace>:<kind>` to the lead. Held
 * here rather than in a tree: the tree may be behind another panel's tab, with
 * no box to scroll, or not built yet (TREE-18b, ED-59a).
 */
const bringing = new Map<string, string>();

/**
 * Follows under open folders whose row the panel's listing does not hold, as
 * `<workspace>:<kind>` to the path and the selection the follow found. The
 * file may be gone with no document read yet to say so (§9.20), or newer than
 * a listing kept out of sight or from before a rebuild. The tree selects the
 * row once it draws it, unless its selection changed first, and a read of the
 * folder without it drops the follow: the selection stays as it was (§9.16).
 * A follow `held` off by several highlighted rows waits too (see `follow`).
 */
const awaiting = new Map<string, { path: string; from: selection.Selection; held?: boolean }>();

/** A filter's file list being read, among the directories a tree has in flight: a NUL is in no path. */
const FILES = "\0files";

/**
 * The document in front changed (TREE-18 to TREE-21): each panel that draws
 * `path` selects it alone and scrolls to it once it is on screen. A panel
 * that does not draw it, or highlights several rows, is left as it was, and so
 * is every panel when the file is `gone`, its tab detached: a listing kept out
 * of sight may still name it. Nothing opens, nothing comes forward, and the
 * keyboard stays where it is. A `path` of null, no document in front, follows
 * nothing.
 */
export function followFront(ws: Workspace, path: string | null, gone: boolean): void {
  // A follow still waiting gives way to this one, and to none: settled later
  // it would select a document no longer in front, or no longer open.
  awaiting.delete(`${ws.id}:explorer`);
  awaiting.delete(`${ws.id}:custom`);
  if (path === null || gone) return;
  follow(ws.id, "explorer", ws.expanded, null, path, false);
  const view = shownView(ws);
  if (view) follow(ws.id, "custom", view.expanded, view.entries, path, false);
}

/**
 * One panel's part of a follow. Several rows highlighted hold it off, but
 * counted on listings kept while the tree was out of sight they may be rows
 * since removed: the follow is held, and the tree weighs it again once it has
 * read them, `settled`, and takes it only if at most one is left (TREE-18b).
 */
function follow(wsId: string, kind: Kind, expanded: string[], roots: string[] | null, path: string, settled: boolean): void {
  const id = `${wsId}:${kind}`;
  const kept = `${wsId}:tree:${kind}`;
  const key = selectionKey(wsId, kind);
  const sel = peek<selection.Selection>(key) ?? selection.NONE;
  const filter = peek<string>(`${kept}:filter`) ?? "";
  const files = peek<string[] | null>(`${kept}:files`) ?? null;
  const listings = peek<Map<string, Entry[]>>(`${kept}:listings`);
  // A filter draws from its file list, and a view draws its entries whatever
  // the disk holds. Beneath those the tree walks its listings down, so a row
  // is drawn only while the listing kept of every folder on the way still
  // names the next: one inside a folder deleted outside the app is not, even
  // with the dead folder's own listing kept. A folder with no listing kept
  // says nothing until the tree has read every folder it draws, `settled`:
  // then its read failed, and it draws nothing. Each listing is made a set
  // once, however many paths ask.
  const names = new Map<string, Set<string> | undefined>();
  const lists = (dir: string, p: string) => {
    if (!names.has(dir)) {
      const listed = listings?.get(dir);
      names.set(dir, listed && new Set(listed.map((e) => e.path)));
    }
    return names.get(dir)?.has(p) ?? !settled;
  };
  const unlisted = (p: string) => {
    if (filter) return false;
    for (let d = p; d && !roots?.includes(d); d = dirOf(d)) if (!lists(dirOf(d), d)) return true;
    return false;
  };
  // Only rows still drawn make a multi-selection (TREE-21). A path moved,
  // deleted or folded away stays in the set with no row to highlight, and
  // would otherwise hold off every follow until the owner clicks the tree.
  // The panel is weighed once for a selection of several, which under a
  // filter is a pass over the whole list; one path walks it only to a match.
  const shows = sel.set.size > 1 ? selection.drawing(expanded, roots, filter, files) : (p: string) => selection.draws(p, expanded, roots, filter, files);
  let highlighted = 0;
  for (const p of sel.set) if (shows(p) && !unlisted(p) && ++highlighted > 1) break;
  awaiting.delete(id);
  if (!shows(path)) return;
  if (highlighted > 1) {
    if (settled) return;
    // A fresh value, so a tree on screen redraws and settles it at once
    // rather than on a later fold that leaves one row.
    const from = { ...sel };
    awaiting.set(id, { path, from, held: true });
    put(key, from);
    return;
  }
  if (unlisted(path)) { awaiting.set(id, { path, from: sel }); return; }
  // Selected alone already, it keeps the copy it leads at in a view; a fresh
  // value all the same, so the tree redraws and scrolls to it.
  const stays = sel.set.size === 1 && sel.set.has(path) ? sel.lead : null;
  bringing.set(id, stays ?? path);
  put(key, stays ? { ...sel } : selection.only({ key: path, path }));
}

/**
 * Show in Explorer and Reveal in Explorer (ED-59, ED-59b): the Explorer
 * selects the path alone, clearing a filter that hides it first, and scrolls
 * to it once the folders above it are open and it is on screen. The Workspace
 * window opens those folders and brings the Explorer forward.
 */
export function revealInTree(workspaceId: string, path: string): void {
  const kept = `${workspaceId}:tree:explorer`;
  const filter = peek<string>(`${kept}:filter`) ?? "";
  if (filter && !selection.draws(path, [], null, filter, peek<string[] | null>(`${kept}:files`) ?? null)) {
    put(`${kept}:filter`, "");
    put(`${kept}:files`, null);
  }
  bringing.set(`${workspaceId}:explorer`, path);
  put(selectionKey(workspaceId, "explorer"), selection.only({ key: path, path }));
}

/**
 * Trees asked for the keyboard — by their tab, Ctrl+Shift+E or a reveal —
 * that have not taken it yet, as `<workspace>:<kind>`. Heard here, as Search
 * hears it: the asking comes first when it is what brings the tree into being.
 */
const wanted = new Set<string>();
window.addEventListener("panel-focus", (e) => {
  const { workspaceId, id } = (e as CustomEvent<{ workspaceId: string; id: string }>).detail;
  if (id === "explorer" || id === "custom") wanted.add(`${workspaceId}:${id}`);
});

/** The path the copy-path key names: the lead of the tree holding the keyboard, else the Explorer's. */
export function treeLead(workspaceId: string): string | null {
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".tree")?.dataset.kind;
  const lead = peek<selection.Selection>(selectionKey(workspaceId, focused === "custom" ? "custom" : "explorer"))?.lead;
  return lead ? selection.pathOf(lead) : null;
}

/**
 * A drag from another application is seen only through Tauri, which says
 * where it is: `el` is the row or tree background under it, carrying the
 * folder it stands for, or null once it is nowhere. The tree holding it
 * marks that folder (TREE-14).
 */
export function externalOver(el: Element | null): void {
  window.dispatchEvent(new CustomEvent("tree-drop-over", { detail: el }));
}

/** Files from another application dropped on `el`: the tree holding it copies them into its folder (TREE-14). */
export function externalDrop(el: Element, paths: string[]): void {
  window.dispatchEvent(new CustomEvent("tree-drop-in", { detail: { el, paths } }));
}

/**
 * Explorer: the tree rooted at the workspace, read one directory at a time.
 * Custom: one of the workspace's views — its entries at the root whatever
 * their depth, each expanding to its real children (VIEW-03, VIEW-04).
 *
 * The tree is taken down when its workspace or mode leaves the screen. Its
 * listings, filter, view entries, selection and scroll are kept per
 * workspace and kind, so the tree built again paints as it was left, then
 * reads what it draws afresh — it heard no change while it was down.
 */
export function FileTree({ ws, kind, onOpen, onQuote, gitStatus = [] }: Props) {
  const gitMap = useMemo(() => statusMap(gitStatus), [gitStatus]);
  const kept = `${ws.id}:tree:${kind}`;
  const [listings, setListings] = useKept(`${kept}:listings`, NOTHING);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [asking, setAsking] = useState<Question | null>(null);
  const [filter, setFilter] = useKept(`${kept}:filter`, "");
  const [allFiles, setAllFiles] = useKept<string[] | null>(`${kept}:files`, null);
  const [viewEntries, setViewEntries] = useKept<Entry[] | null>(`${kept}:view`, null);
  /** This panel's own rows selected, lead and anchor: a click, a key or a reveal in the other panel never changes them. */
  const selKey = selectionKey(ws.id, kind);
  const [sel, setSel] = useKept(selKey, selection.NONE);
  /** The selection as it is now, not as this render drew it: a key pressed before the tree redraws starts where the last one left it. */
  const selNow = () => peek<selection.Selection>(selKey) ?? sel;
  /** Every row drawn in this render, in tree order. */
  const order = useRef<TreeRow[]>([]);
  /**
   * Where a tree drag over this tree would land, marked: the folder it goes
   * into (`""` the root), or the view entry it goes before (VIEW-12). Every
   * dragover this tree accepts marks again, and any other takes the mark off.
   */
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  /** The dragover that last marked a target here. */
  const marked = useRef<Event | null>(null);
  /** Whether the desktop clipboard holds files, so Paste is offered or not. */
  const [hasFiles, setHasFiles] = useState(clipboardHasFiles === true);
  /** Directories still drawn while their collapse plays out. */
  const [collapsing, setCollapsing] = useState<Set<string>>(new Set());
  const inflight = useRef(new Set<string>());
  const view = kind === "custom" ? shownView(ws) : null;
  const entriesKey = view?.entries.join("\n") ?? "";
  const roots = view?.entries ?? null;
  /** The folders this panel draws open: the Explorer's, or the view's own (TREE-20). */
  const expanded = view?.expanded ?? ws.expanded;
  /** What callbacks outliving a render read: this panel's expansion, and the view with its entries as of the last one. */
  const latest = useRef({ expanded, roots, view: view?.id ?? null });
  latest.current = { expanded, roots, view: view?.id ?? null };
  /** Opens or folds folders in this panel only. */
  const setOpen = (paths: string[], open: boolean) => api.setExpanded(ws.id, paths, open, latest.current.view);

  /**
   * A follow held off by several highlighted rows is weighed again once the
   * tree is on screen with every read it asked for back, and so counts rows
   * as the disk holds them now (TREE-18b).
   */
  const settle = useCallback(() => {
    const id = `${ws.id}:${kind}`;
    const want = awaiting.get(id);
    if (!want?.held || !liveRef.current || inflight.current.size) return;
    if (peek(selKey) !== want.from) awaiting.delete(id);
    else follow(ws.id, kind, latest.current.expanded, latest.current.roots, want.path, true);
  }, [ws.id, kind, selKey]);

  // A listing that comes back as it was changes nothing and draws nothing; one
  // for a directory folded while it was read is dropped.
  const load = useCallback((dir: string) => {
    if (inflight.current.has(dir)) return;
    inflight.current.add(dir);
    api.listDir(ws.id, dir)
      .then((entries) => {
        const id = `${ws.id}:${kind}`;
        const want = awaiting.get(id);
        if (want && dirOf(want.path) === dir && !entries.some((e) => e.path === want.path)) awaiting.delete(id);
        setListings((m) => {
          if (dir && !latest.current.expanded.includes(dir)) return m;
          return same(m.get(dir), entries) ? m : new Map(m).set(dir, entries);
        });
      })
      // A directory deleted while it was open stays in the expanded set, and
      // every build would report it again; it is folded instead. The fold
      // lands later, and its listing goes now: until then the tree would draw
      // the rows it names, and a held follow settling would count them (TREE-21).
      .catch((e) => {
        if (!dir || !/No such file|os error 2/i.test(String(e))) { report(e); return; }
        setListings((m) => {
          if (!m.has(dir)) return m;
          const next = new Map(m);
          next.delete(dir);
          return next;
        });
        void api.setExpanded(ws.id, [dir], false, latest.current.view).catch(() => {});
      })
      .finally(() => {
        inflight.current.delete(dir);
        settle();
      });
  }, [ws.id, kind, setListings, settle]);

  const loadView = useCallback(() => {
    if (!view) { setViewEntries(null); return; }
    api.statEntries(ws.id, view.entries).then((e) => setViewEntries((prev) => (same(prev, e) ? prev : e))).catch(report);
  }, [ws.id, view?.id, entriesKey, setViewEntries]); // eslint-disable-line react-hooks/exhaustive-deps

  // Built, the tree reads its root and every directory it draws open, and a
  // filter's file list: it heard nothing while it was down, and it paints
  // from what it kept until the answers land. A directory opened after that is
  // read as it opens. A file list dropped meanwhile, with its filter, stays
  // dropped.
  const expandedKey = expanded.join("\n");
  const built = useRef(false);
  /** What the last pass drew: a directory coming into view is read even with a
   *  listing kept, which the other tree may have folded and let go stale. */
  const wasDrawn = useRef(new Set<string>());
  useEffect(() => {
    const all = !built.current;
    built.current = true;
    if (all && kind === "explorer") load("");
    const now = drawn(expanded, roots);
    for (const dir of now) if (all || !wasDrawn.current.has(dir)) load(dir);
    wasDrawn.current = new Set(now);
    if (all && filter && allFiles !== null) refetchFiles(0);
  }, [expandedKey, entriesKey, load]); // eslint-disable-line react-hooks/exhaustive-deps

  // A filter's file list is read again after a change, and the kept one paints
  // until the answer lands. An agent writing in a watched directory reports a
  // change several times a second, and every read walks the whole tree, so the
  // changes of a second share one read; only the latest read asked for lands.
  // From the asking until it has, the list counts as in flight, like a
  // listing, so a held follow is weighed against the disk as it is now. A
  // read asked for meanwhile does not hold it off further: an agent writing
  // all the while would hold it off for good.
  const filesRead = useRef<{ timer: number | null; asked: number }>({ timer: null, asked: 0 });
  const refetchFiles = (delay: number) => {
    const read = filesRead.current;
    if (read.timer !== null) return;
    inflight.current.add(FILES);
    read.timer = window.setTimeout(() => {
      read.timer = null;
      const asked = ++read.asked;
      api.listFiles(ws.id)
        .then((files) => { if (read.asked === asked) setAllFiles((prev) => (prev === null || same(prev, files) ? prev : files)); })
        .catch(report)
        .finally(() => {
          if (read.asked !== asked) return;
          inflight.current.delete(FILES);
          settle();
        });
    }, delay);
  };
  useEffect(() => () => { if (filesRead.current.timer !== null) window.clearTimeout(filesRead.current.timer); }, []);

  useEffect(() => { loadView(); }, [loadView]);

  // A directory that leaves the expanded set keeps its children on screen for
  // as long as the collapse takes; React would otherwise take them away before
  // the first frame of it. Then its listing goes, with those of the
  // directories inside it, and is read afresh when it opens again. The timer
  // runs out even when another directory folds meanwhile.
  const wasExpanded = useRef(expanded);
  // Another view shown holds its own folders open (TREE-20), and draws them as
  // they are, with nothing unfolding or folding to get there.
  const wasView = useRef(view?.id);
  if (wasView.current !== view?.id) {
    wasView.current = view?.id;
    wasExpanded.current = expanded;
  }
  useEffect(() => {
    const gone = wasExpanded.current.filter((d) => !expanded.includes(d));
    wasExpanded.current = expanded;
    if (!gone.length) return;
    setCollapsing((all) => new Set([...all, ...gone]));
    window.setTimeout(() => {
      setCollapsing((all) => {
        const next = new Set(all);
        gone.forEach((d) => next.delete(d));
        return next;
      });
      const shown = new Set(drawn(latest.current.expanded, latest.current.roots));
      setListings((m) => {
        const folded = [...m.keys()].filter((k) => !shown.has(k) && gone.some((d) => k === d || k.startsWith(`${d}/`)));
        if (!folded.length) return m;
        const next = new Map(m);
        folded.forEach((k) => next.delete(k));
        return next;
      });
    }, duration("--d-base"));
  }, [expandedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The watcher's reports: the directories this tree has listed are read
  // again, and the view's entries when one of them, or the directory holding
  // it, changed. A directory just created reports itself rather than the one
  // holding it, so a listed parent that does not show it yet is read too. Out
  // of sight — behind another panel's tab — the directories are only noted,
  // and read once when the tree is back in front.
  const relist = (dirs: Iterable<string>) => {
    const listed = (dir: string) => (dir === "" && kind === "explorer") || listings.has(dir);
    let touched = false;
    for (const dir of dirs) {
      if (listed(dir)) load(dir);
      const parent = dirOf(dir);
      if (dir && listed(parent) && !listings.get(parent)?.some((e) => e.path === dir)) load(parent);
      if (roots?.some((e) => e === dir || dirOf(e) === dir)) touched = true;
    }
    if (filter && allFiles !== null) refetchFiles(1000);
    if (touched) loadView();
  };
  const onDirs = useRef(relist);
  onDirs.current = relist;
  const live = useLive();
  const liveRef = useRef(live);
  liveRef.current = live;
  const stale = useRef(new Set<string>());
  useEffect(() => {
    const unlisten = events.onDirChanged((change) => {
      if (change.workspaceId !== ws.id) return;
      if (liveRef.current) onDirs.current(change.dirs);
      else change.dirs.forEach((d) => stale.current.add(d));
    });
    return () => { void unlisten.then((u) => u()); };
  }, [ws.id]);
  useEffect(() => {
    if (!live || stale.current.size === 0) return;
    const dirs = [...stale.current];
    stale.current.clear();
    onDirs.current(dirs);
  }, [live]);

  // The filter needs every path; it is fetched as a filter session starts.
  useEffect(() => {
    if (filter && allFiles === null) api.listFiles(ws.id).then(setAllFiles).catch(report);
  }, [filter, allFiles, ws.id]);

  /**
   * The directories opened since the tree last drew — from a click, a
   * breadcrumb's Reveal in Explorer, a paste or a new folder: their branches alone unfold, never
   * the ones drawn open as the tree is built.
   */
  const opened = built.current ? expanded.filter((d) => !wasExpanded.current.includes(d)) : [];
  const toggle = (path: string) => void setOpen([path], !expanded.includes(path));

  // Filtered view: matching files and their ancestors, every directory open.
  const filtered = useMemo(() => {
    if (!filter || !allFiles) return null;
    const children = new Map<string, Map<string, boolean>>();
    for (const file of selection.matches(allFiles, filter, view?.entries ?? null)) {
      const parts = file.split("/");
      let dir = "";
      parts.forEach((part, i) => {
        const isLast = i === parts.length - 1;
        if (!children.has(dir)) children.set(dir, new Map());
        children.get(dir)!.set(part, !isLast);
        dir = join(dir, part);
      });
    }
    return children;
  }, [filter, allFiles, view?.entries]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The highlighted rows the panel draws, each path once, in tree order: what
   * Delete, a copy, a cut, a drag and Quote to AI take (TREE-22a). A row
   * folded out of sight is not among them.
   */
  const picked = (): TreeRow[] => {
    const seen = new Set<string>();
    const { set } = selNow();
    return order.current.filter((r) => set.has(r.path) && !seen.has(r.path) && !!seen.add(r.path));
  };
  /** What a drag or a menu on `r` takes: the whole selection when the row is in it, in tree order. */
  const taking = (r: TreeRow): TreeRow[] => (selNow().set.has(r.path) ? picked() : [r]);
  const leadRow = (): TreeRow | undefined => order.current[selection.indexOf(order.current, selNow().lead)];
  /** The one row F2, Rename and Duplicate act on: none while several are selected. */
  const single = (): TreeRow | null => {
    const rows = picked();
    return rows.length === 1 ? rows[0] : null;
  };

  /** Where a new file or folder goes: inside the lead folder, beside the lead file, else the root (TREE-22a). */
  const creationDir = (): string | null => {
    const lead = leadRow();
    if (lead) return lead.entry.isDir ? lead.path : dirOf(lead.path);
    return view ? null : "";
  };

  /**
   * Asking the clipboard costs a round trip to whichever application owns it,
   * so this is asked when the first tree appears and again as a menu opens,
   * rather than on every render or every rebuild. A stale answer costs at
   * worst a Paste entry that finds nothing — the paste itself asks again.
   */
  const holdsFiles = (has: boolean) => { clipboardHasFiles = has; setHasFiles(has); };
  const askClipboard = () => {
    api.clipboardFiles().then((c) => holdsFiles(c.paths.length > 0)).catch(() => holdsFiles(false));
  };
  useEffect(() => { if (clipboardHasFiles === null) askClipboard(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const openMenu = (m: Menu) => {
    setMenu(m);
    askClipboard();
  };

  const targetDir = (): string => {
    const e = menu?.row?.entry;
    return e ? (e.isDir ? e.path : dirOf(e.path)) : "";
  };

  const question = (q: Omit<Question, "answer">) =>
    new Promise<{ ok: boolean; checked: boolean; alt: boolean }>((answer) => setAsking({ ...q, answer }));

  /**
   * Asks before a trash unless the setting says not to (SET-05), naming what
   * goes; ticking Don't ask again turns the setting off (SET-05a).
   */
  const mayTrash = async (going: TreeRow[]): Promise<boolean> => {
    if (settings.get()?.confirmDelete === false) return true;
    const names = going.map((r) => (r.entry.isDir ? `${r.path}/` : r.path));
    const { ok, checked } = await question({
      title: "Move to trash",
      message: names.length === 1 ? `Move ${names[0]} to the trash?` : `Move these ${names.length} items to the trash?\n\n${selection.listed(names)}`,
      checkbox: { label: "Don't ask again" },
      ok: "Move to trash",
      cancel: "Keep",
    });
    if (ok && checked) void settings.update({ confirmDelete: false }).catch(report);
    return ok;
  };

  /**
   * Delete and Move to trash: the rows go to the desktop's trash as
   * `selection.deleting` weighs them (TREE-25, TREE-25a). With `shortcuts`, a
   * row that is one of the view's own entries leaves the view instead, and no
   * file is touched (VIEW-07). Failures are one notice, a line each
   * (TREE-25b), and the selection moves on to the row after the last one
   * removed.
   */
  const remove = async (rows: TreeRow[], shortcuts: boolean) => {
    const { leaving, going } = selection.deleting(rows, shortcuts && view ? view.entries : []);
    if (!leaving.length && !going.length) return;
    if (going.length && !(await mayTrash(going))) return;
    const gone = [...leaving, ...going].map((r) => r.path);
    const next = selection.afterRemoval(order.current, gone);
    if (view && leaving.length) await api.viewRemove(ws.id, view.id, leaving.map((r) => r.path)).catch(report);
    const failed = going.length ? await api.trashEntries(ws.id, going.map((r) => r.path)).catch((e) => { report(e); return null; }) : [];
    if (failed === null) return;
    if (failed.length) report(failed.join("\n"));
    if (failed.length < gone.length) setSel(next ? selection.only(next) : selection.NONE);
  };

  /**
   * Copy and cut go to the desktop's clipboard, not a variable of this module.
   * One clipboard is what makes the newest copy win whichever window made it,
   * and it is the same clipboard a file manager pastes from (FIX-12). A
   * folder's own entries go with it, not beside it (TREE-26a).
   */
  const copy = (cut: boolean) => {
    const paths = selection.outermost(picked().filter((r) => !r.entry.missing).map((r) => r.path));
    if (paths.length) void api.setClipboardFiles(paths.map((p) => `${ws.path}/${p}`), cut).then(() => holdsFiles(true)).catch(report);
  };

  /**
   * Before a Replace, the tabs open on what is replaced or on anything in it:
   * a clean one is closed, and one with unsaved changes stops the Replace,
   * since its buffer would outlive its file. A tab not opened this session
   * keeps its unsaved changes as a draft, which would be laid over whatever
   * lands at its path the next time it opens. The tabs are those of every
   * workspace on these files, as a move reaches them (TREE-26c): a child's
   * folder lies inside its root's, and one file is open in both.
   */
  const closeTabsUnder = async (dest: string): Promise<void> => {
    const abs = `${ws.path}/${dest}`;
    const { workspaces } = await api.getSession();
    const tabs = workspaces.flatMap((w) => [...w.groups, ...w.review.groups].flatMap((g) => g.editors)
      .filter((t) => { const at = `${w.path}/${t.path}`; return at === abs || at.startsWith(`${abs}/`); })
      .map((t) => ({ w, t })));
    const drafted = await Promise.all(tabs.map(({ w, t }) => !editors.get(t.id) && api.readDraft(w.id, t.path).then((d) => d !== null, () => false)));
    const dirty = tabs.find(({ t }, i) => editors.isDirty(t.id) || drafted[i]);
    if (dirty) throw `${dirty.t.path}${dirty.w.id === ws.id ? "" : ` in ${dirty.w.name}`} has unsaved changes, so ${dest} was not replaced.`;
    for (const { w, t } of tabs) await api.closeFile(w.id, t.id);
  };

  /**
   * Puts one absolute path into `dir`, asking first when its name is taken
   * there (TREE-12) — unless an answer was given for all of them already
   * (TREE-27), which `rule` holds. `more` says entries follow this one, so
   * the question offers Apply to all. Answers where it landed, or "stop"
   * when the answer was to cancel the rest.
   */
  const place = async (from: string, dir: string, cut: boolean, rule: { all: "replace" | "keep" | null }, more: boolean): Promise<string | null | "stop"> => {
    const first = await api.pasteEntry(ws.id, from, dir, cut, "ask");
    if (!first.exists) return first.path;
    const dest = join(dir, from.slice(from.lastIndexOf("/") + 1));
    // Pasted where it already is, a copy takes a free name beside itself, as Duplicate does.
    if (from === `${ws.path}/${dest}`) return (await api.pasteEntry(ws.id, from, dir, cut, "keep")).path;
    let answer = rule.all;
    if (!answer) {
      const a = await question({
        title: "Name taken",
        message: `${dest} already exists. Replace it, sending the one there to the trash, or keep both?`,
        checkbox: more ? { label: "Apply to all" } : undefined,
        ok: "Replace",
        alt: "Keep both",
        cancel: "Cancel",
      });
      answer = a.alt ? "keep" : a.ok ? "replace" : null;
      if (a.checked) rule.all = answer;
    }
    if (answer === "keep") return (await api.pasteEntry(ws.id, from, dir, cut, "keep")).path;
    if (answer !== "replace") return "stop";
    await closeTabsUnder(dest);
    return (await api.pasteEntry(ws.id, from, dir, cut, "replace")).path;
  };

  const undoKey = `${ws.id}:tree:undo`;

  /**
   * Copies, or moves when `cut`, absolute paths into the folder `dir`: the
   * clipboard's paste, a drop from a tree and a drop from another
   * application. A folder goes once with everything in it, and never into
   * itself: then nothing goes (TREE-26a). The folder then opens and is read
   * — a folded one is not watched — and what landed is selected. The moves
   * made inside the workspace are kept together for one Ctrl+Z (TREE-13,
   * TREE-26b), and the failures are one notice, a line each.
   */
  const transfer = async (paths: string[], dir: string, cut: boolean): Promise<void> => {
    const into = dir ? `${ws.path}/${dir}` : ws.path;
    const itself = paths.find((a) => into === a || into.startsWith(`${a}/`));
    if (itself) { report(`${itself} cannot go into itself, so nothing was ${cut ? "moved" : "copied"}.`); return; }
    const going = selection.outermost(paths);
    const rule: { all: "replace" | "keep" | null } = { all: null };
    const landed: string[] = [];
    const moved: Move[] = [];
    const failed: string[] = [];
    for (const [i, from] of going.entries()) {
      let to: string | null;
      try {
        const landing = await place(from, dir, cut, rule, i < going.length - 1);
        if (landing === "stop") break;
        to = landing;
      } catch (e) {
        failed.push(String(e));
        continue;
      }
      if (to === null) continue;
      landed.push(to);
      const rel = from.startsWith(`${ws.path}/`) ? from.slice(ws.path.length + 1) : null;
      if (cut && rel !== null && rel !== to) moved.push({ from: rel, to });
    }
    if (failed.length) report(failed.join("\n"));
    if (moved.length) keep(undoKey, [...(peek<Move[][]>(undoKey) ?? []), moved].slice(-UNDO_DEPTH));
    if (dir && !latest.current.expanded.includes(dir)) await setOpen([dir], true).catch(() => {});
    load(dir);
    const last = landed[landed.length - 1];
    if (last) setSel({ set: new Set(landed), lead: last, anchor: last });
  };

  /**
   * Ctrl+Z: the last batch of moves goes back where it came from. A place
   * taken since keeps what is there. What went back is selected, as a move
   * selects what landed: the paths it left name no row now.
   */
  const undoMoves = async () => {
    const stack = peek<Move[][]>(undoKey) ?? [];
    const batch = stack[stack.length - 1];
    if (!batch) return;
    keep(undoKey, stack.slice(0, -1));
    const back: string[] = [];
    for (const { from, to } of [...batch].reverse()) {
      await api.renameEntry(ws.id, to, from).then(
        () => back.unshift(from),
        (e) => report(/already exists/.test(String(e)) ? `${from} is taken now, so ${to} stays where it is.` : e),
      );
    }
    const last = back[back.length - 1];
    if (last) setSel({ set: new Set(back), lead: last, anchor: last });
  };

  const paste = async (dir = creationDir()) => {
    if (dir === null) return;
    const { paths, cut } = await api.clipboardFiles().catch((e) => { report(e); return { paths: [], cut: false }; });
    if (!paths.length) return;
    await transfer(paths, dir, cut);
    // The files are no longer where the cut says they are.
    if (cut) { await api.clearClipboardFiles().catch(() => {}); holdsFiles(false); }
  };

  /** A key moved the lead: its row is kept in view (TREE-24). */
  const followLead = useRef(false);

  /**
   * The arrows, Home and End move the selection over the drawn rows without
   * opening anything, Shift extending it from the anchor (TREE-24 to
   * TREE-24b). → unfolds a folder, then steps into it; ← folds it, and from
   * anything else steps out to the folder drawing it (TREE-24c).
   */
  const navigate = (key: string, shift: boolean) => {
    const rows = order.current;
    if (!rows.length) return;
    const at = selection.indexOf(rows, selNow().lead);
    const cur = rows[at];
    let to: number;
    if (key === "Home") to = 0;
    else if (key === "End") to = rows.length - 1;
    else if (!cur) to = 0;
    else if (key === "ArrowDown") to = Math.min(at + 1, rows.length - 1);
    else if (key === "ArrowUp") to = Math.max(at - 1, 0);
    else if (key === "ArrowRight") {
      if (cur.entry.isDir && !cur.entry.missing && !cur.open && cur.folds) { toggle(cur.path); return; }
      if (!cur.entry.isDir || rows[at + 1]?.parent !== at) return;
      to = at + 1;
    } else {
      if (cur.entry.isDir && cur.open && cur.folds) { toggle(cur.path); return; }
      if (cur.parent === -1) return;
      to = cur.parent;
    }
    const along = shift && key !== "ArrowLeft" && key !== "ArrowRight";
    setSel((s) => (along ? selection.extend(s, rows, to, false) : selection.only(rows[to])));
    followLead.current = true;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const ctrl = e.ctrlKey && !e.altKey && !e.shiftKey;
    if (ctrl && key === "c") copy(false);
    else if (ctrl && key === "x") copy(true);
    else if (ctrl && key === "v") void paste();
    else if (ctrl && key === "z") void undoMoves();
    else if (ctrl && key === "a") setSel((s) => selection.all(s, order.current));
    else if (!e.ctrlKey && !e.altKey && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) navigate(e.key, e.shiftKey);
    else if (!e.ctrlKey && e.key === "Delete") void remove(picked(), true);
    else if (!e.ctrlKey && e.key === "F2") { const one = single(); if (one && !one.entry.missing) setDialog({ kind: "rename", entry: one.entry }); }
    else if (!e.ctrlKey && e.key === "Enter") {
      const lead = leadRow();
      if (lead?.entry.isDir) toggle(lead.path);
      else if (lead && !lead.entry.missing) onOpen(lead.path, false);
    } else if (e.key === "Escape") { const lead = leadRow(); setSel(lead ? selection.only(lead) : selection.NONE); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const deleteView = async (v: View) => {
    const yes = await ask(`Delete the view "${v.name}"? Only the list goes; every file it points at stays.`, { title: "Delete view", kind: "warning", okLabel: "Delete view", cancelLabel: "Keep" });
    if (yes) await api.viewDelete(ws.id, v.id).catch(report);
  };

  const submitDialog = async (value: string) => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    try {
      if (d.kind === "new-file" || d.kind === "new-folder") {
        const path = join(d.dir, value);
        await api.createEntry(ws.id, path, d.kind === "new-folder");
        if (d.dir && !expanded.includes(d.dir)) await setOpen([d.dir], true);
        load(d.dir);
        if (d.kind === "new-file") onOpen(path, false);
      } else if (d.kind === "rename") {
        await api.renameEntry(ws.id, d.entry.path, join(dirOf(d.entry.path), value));
      } else if (d.kind === "new-view") {
        const id = await api.viewCreate(ws.id, value);
        if (d.then?.length) await api.viewAdd(ws.id, id, d.then);
      } else if (d.kind === "rename-view") {
        await api.viewRename(ws.id, d.view.id, value);
      }
    } catch (e) {
      report(e);
    }
  };

  // A view's root rows are reordered by dragging onto another: they land
  // before it, in the order they had (VIEW-12).
  const reorderTo = (dragged: string[], target: string) => {
    if (!view || dragged.includes(target)) return;
    const paths = view.entries.filter((p) => !dragged.includes(p));
    const at = paths.indexOf(target);
    paths.splice(at < 0 ? paths.length : at, 0, ...dragged);
    void api.viewReorder(ws.id, view.id, paths).catch(report);
  };

  // A tree drag is read from the router, never from its data (dropRoute.ts).
  // A target that takes it offers the drop and marks itself; one that
  // refuses leaves the drop to be cancelled there.
  const aim = (ev: React.DragEvent, run: DropAction, into: string | null, before: string | null) => {
    if (!offerDrop(ev, run)) return;
    marked.current = ev.nativeEvent;
    setDropDir(into);
    setDragOver(before);
  };
  /** Into the folder `dir`: never a missing entry, never a folder into itself or anything under it, and what is already there stays out of it. */
  const aimInto = (ev: React.DragEvent, drag: TreeDrag, dir: string) => {
    const into = dir ? `${ws.path}/${dir}` : ws.path;
    if (drag.missing || drag.abs.some((a) => into === a || into.startsWith(`${a}/`))) return;
    const coming = drag.abs.filter((a) => a.slice(0, a.lastIndexOf("/")) !== into);
    if (coming.length) aim(ev, ({ copy }) => void transfer(coming, dir, !copy), dir, null);
  };
  /**
   * Where a drop on a row goes: a folder takes it, a file hands it to its
   * folder. A file at a view's root sits in no folder the view shows, so it
   * takes nothing (VIEW-06).
   */
  const dropDirOf = (e: Entry, viewRoot: boolean): string | null => (e.missing ? null : e.isDir ? e.path : viewRoot ? null : dirOf(e.path));
  /** A view's own entries dragged onto another of them reorder the view; anything else goes into the row's folder. */
  const aimRow = (ev: React.DragEvent, drag: TreeDrag, e: Entry, viewRoot: boolean) => {
    if (viewRoot && view && drag.roots === view.id) {
      if (!drag.paths.includes(e.path)) aim(ev, () => reorderTo(drag.paths, e.path), null, e.path);
      return;
    }
    const dir = dropDirOf(e, viewRoot);
    if (dir !== null) aimInto(ev, drag, dir);
  };
  const dragFrom = (ev: React.DragEvent, r: TreeRow) => {
    const rows = taking(r);
    const paths = rows.map((x) => x.path);
    const missing = rows.some((x) => !!x.entry.missing);
    // One entry carries its file for other applications (TREE-15). WebKit
    // runs several URIs together into one, so a selection carries none.
    const uri = paths.length === 1 && !missing;
    startTreeDrag({
      workspaceId: ws.id,
      paths,
      abs: selection.outermost(paths).map((p) => `${ws.path}/${p}`),
      dirs: new Set(rows.filter((x) => x.entry.isDir).map((x) => x.path)),
      roots: view && paths.every((p) => view.entries.includes(p)) ? view.id : null,
      missing,
      uri,
    });
    // WebKitGTK starts no drag without data; nothing reads this back.
    ev.dataTransfer.setData(FILE_MIME, paths.join("\n"));
    if (uri) ev.dataTransfer.setData("text/uri-list", fileUri(`${ws.path}/${paths[0]}`));
    ev.dataTransfer.effectAllowed = "copyMove";
  };

  // What this render draws: the rows, in order, and which of them leads.
  // Rows in a branch folding away are still drawn until it has, and are no
  // longer the tree's to act on.
  const uid = useId();
  order.current = [];
  let closing = 0;
  let leadId: string | undefined;
  // The row that leads, as `selection.indexOf` finds it: the copy the lead
  // names while it is drawn, else the first copy of its path (TREE-23a). A
  // row is drawn before the tree knows what follows it, so the folders say
  // whether a view's copy is drawn.
  const leadName = ((lead) => {
    const cut = lead?.indexOf("\0") ?? -1;
    if (lead === null || cut === -1) return lead;
    const entry = lead.slice(0, cut);
    const drawnThere = !!roots?.includes(entry) && selection.draws(selection.pathOf(lead), expanded, [entry], filter, allFiles);
    return drawnThere ? lead : selection.pathOf(lead);
  })(sel.lead);

  /** `at` places the row: the view entry it is drawn under (null in the Explorer), its parent row, and how it folds. */
  const row = (e: Entry, depth: number, open: boolean, onClick: () => void, at: { root: string | null; parent: number; viewRoot?: boolean; folds?: boolean }) => {
    const viewRoot = !!at.viewRoot;
    const r: TreeRow = { key: at.root === null ? e.path : `${at.root}\0${e.path}`, path: e.path, entry: e, open, folds: at.folds ?? true, viewRoot, parent: at.parent };
    const index = closing ? -1 : order.current.push(r) - 1;
    const isLead = index !== -1 && leadId === undefined && (r.key === leadName || r.path === leadName);
    const id = `${uid}-${index}`;
    if (isLead) leadId = id;
    const selected = sel.set.has(e.path);
    const icon = fileIcon(e.name, e.isDir, open);
    return (
      <div
        id={index === -1 ? undefined : id}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={e.isDir ? open : undefined}
        aria-level={depth + 1}
        data-path={e.path}
        data-drop-dir={dropDirOf(e, viewRoot) ?? undefined}
        className={`tree-row${e.ignored ? " ignored" : ""}${e.missing ? " missing" : ""}${selected ? " selected" : ""}${isLead ? " lead" : ""}${dragOver === e.path ? " drop-before" : ""}${e.isDir && dropDir === e.path ? " drop-into" : ""}${gitMap.has(e.path) ? ` git-${gitMap.get(e.path)}` : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        // Ctrl takes a row in or out, Shift takes the rows from the anchor,
        // both together add them; none of them opens a file (TREE-22, TREE-23).
        onClick={(ev) => {
          if (index === -1) return;
          const rows = order.current;
          if (ev.shiftKey) setSel((s) => selection.extend(s, rows, index, ev.ctrlKey));
          else if (ev.ctrlKey) setSel((s) => selection.toggle(s, rows, index));
          else {
            setSel(selection.only(r));
            onClick();
          }
        }}
        onDoubleClick={(ev) => { if (!ev.ctrlKey && !ev.shiftKey && !e.isDir && !e.missing) onOpen(e.path, false); }}
        // A missing entry at a view's root still drags, to be reordered.
        draggable={viewRoot || !e.missing}
        onDragStart={(ev) => dragFrom(ev, r)}
        onDragOver={(ev) => { const drag = treeDrag(); if (drag) aimRow(ev, drag, e, viewRoot); }}
        onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); if (!selNow().set.has(e.path)) setSel(selection.only(r)); openMenu({ x: ev.clientX, y: ev.clientY, row: r }); }}
        title={e.missing ? `Missing: ${e.path}` : e.path}
      >
        <span className={`tree-chevron${open ? " open" : ""}`}>{e.isDir ? "▸" : ""}</span>
        <Icon name={icon.name} color={e.ignored || e.missing ? undefined : icon.color} />
        <span className="tree-name">{e.missing ? e.path : e.name}</span>
        {gitMap.has(e.path) && <span className="tree-git">{e.isDir ? "•" : gitMap.get(e.path)}</span>}
      </div>
    );
  };

  /**
   * A directory's children, revealed and hidden by their own height (§11.3).
   * They are drawn only while the branch is open or folding away.
   */
  const branch = (path: string, open: boolean, children: () => React.ReactNode): React.ReactNode => {
    if (!open && !collapsing.has(path)) return null;
    if (!open) closing++;
    const inner = children();
    if (!open) closing--;
    return <div className={`tree-branch${open ? " open" : ""}${opened.includes(path) ? " unfold" : ""}`}><div>{inner}</div></div>;
  };

  const render = (dir: string, depth: number, parent: number, root: string | null): React.ReactNode => {
    const entries = listings.get(dir);
    if (!entries) return depth === 0 ? <div className="tree-loading loading">Loading…</div> : null;
    return entries.map((e) => {
      const open = e.isDir && expanded.includes(e.path);
      const at = order.current.length;
      return (
        <div key={e.path}>
          {row(e, depth, open, () => { if (e.isDir) toggle(e.path); else onOpen(e.path, true); }, { root, parent })}
          {branch(e.path, open, () => render(e.path, depth + 1, at, root))}
        </div>
      );
    });
  };

  // A view's root: its entries in order, each expanding to real children.
  const renderView = (): React.ReactNode => {
    if (!viewEntries) return <div className="tree-loading loading">Loading…</div>;
    if (viewEntries.length === 0) return <div className="tree-loading">Nothing has been sent to this view yet. Right-click a file or folder in Explorer and choose “Send to view”.</div>;
    return viewEntries.map((e) => {
      const unfolded = e.isDir && expanded.includes(e.path);
      const open = () => { if (e.missing) return; if (e.isDir) toggle(e.path); else onOpen(e.path, true); };
      const at = order.current.length;
      return (
        <div key={e.path}>
          {row(e, 0, unfolded, open, { root: e.path, parent: -1, viewRoot: true })}
          {branch(e.path, unfolded, () => (listings.has(e.path) ? render(e.path, 1, at, e.path) : (load(e.path), null)))}
        </div>
      );
    });
  };

  const renderFiltered = (dir: string, depth: number, parent: number, root: string | null): React.ReactNode => {
    const kids = filtered?.get(dir);
    if (!kids) return null;
    return [...kids.entries()]
      .sort(([a, ad], [b, bd]) => Number(bd) - Number(ad) || a.localeCompare(b))
      .map(([name, isDirectory]) => {
        const e: Entry = { name, path: join(dir, name), isDir: isDirectory, ignored: false };
        const at = order.current.length;
        return (
          <div key={e.path}>
            {row(e, depth, true, () => { if (!e.isDir) onOpen(e.path, true); }, { root, parent, folds: false })}
            {isDirectory && renderFiltered(e.path, depth + 1, at, root)}
          </div>
        );
      });
  };

  // A filtered view keeps its entries at the root and filters beneath them.
  const renderFilteredView = (): React.ReactNode => {
    if (!filtered || !viewEntries) return <div className="tree-loading loading">Loading…</div>;
    return viewEntries
      .filter((e) => e.isDir ? filtered.has(e.path) : e.path.toLowerCase().includes(filter.toLowerCase()))
      .map((e) => {
        const at = order.current.length;
        return (
          <div key={e.path}>
            {row(e, 0, true, () => { if (!e.isDir && !e.missing) onOpen(e.path, true); }, { root: e.path, parent: -1, viewRoot: true, folds: false })}
            {e.isDir && renderFiltered(e.path, 1, at, e.path)}
          </div>
        );
      });
  };

  const citation = (r: TreeRow) => (r.entry.isDir ? `${r.path}/` : r.path);

  const scroller = useKeptScroll<HTMLElement>(`${kept}:scroll`, view ? viewEntries !== null : listings.has(""));
  // A followed or revealed row is scrolled to once it is drawn, the folders
  // above a revealed one opened; behind another panel's tab it has no box yet,
  // and waits. One the reader has since moved away from is dropped rather than
  // paid later.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = `${ws.id}:${kind}`;
    const want = bringing.get(id);
    if (want === undefined) return;
    if (sel.lead !== want) { bringing.delete(id); return; }
    const row = body.current?.querySelector(".tree-row.lead");
    if (!row?.getClientRects().length) return;
    bringing.delete(id);
    row.scrollIntoView({ block: "nearest" });
    // A folder just opened is still unfolding, and its clipped rows do not yet
    // count toward the height the tree scrolls through, so near the end the
    // scroll falls short of the row; it is made again once they do.
    const unfolding: Animation[] = [];
    for (let b = row.closest(".tree-branch"); b; b = b.parentElement?.closest(".tree-branch") ?? null) unfolding.push(...b.getAnimations());
    if (unfolding.length) void Promise.all(unfolding.map((a) => a.finished)).then(() => row.scrollIntoView({ block: "nearest" }), () => {});
  });
  // A follow waiting on the listing selects its row once the tree draws it;
  // a change of selection first, or a fold or filter that hides the path,
  // drops it (§9.16). One held off by several rows is settled instead, as
  // soon as the tree is on screen with nothing left to read.
  useEffect(() => {
    const id = `${ws.id}:${kind}`;
    const want = awaiting.get(id);
    if (!want) return;
    if (selNow() !== want.from || !selection.draws(want.path, expanded, roots, filter, allFiles)) { awaiting.delete(id); return; }
    if (want.held) { settle(); return; }
    const r = order.current.find((x) => x.path === want.path);
    if (!r) return;
    awaiting.delete(id);
    bringing.set(id, r.key);
    setSel(selection.only(r));
  });
  useEffect(() => {
    if (!followLead.current) return;
    followLead.current = false;
    body.current?.querySelector(".tree-row.lead")?.scrollIntoView({ block: "nearest" });
  });

  // The tree takes the keyboard when its tab, Ctrl+Shift+E or a reveal asks
  // for it (TREE-24e) — not when a mode or a workspace comes back and
  // rebuilds it, which returns the keyboard to the document it left.
  const take = useCallback(() => {
    const id = `${ws.id}:${kind}`;
    if (!liveRef.current || !wanted.has(id)) return;
    wanted.delete(id);
    body.current?.querySelector<HTMLElement>(".tree")?.focus({ preventScroll: true });
    body.current?.querySelector(".tree-row.lead")?.scrollIntoView({ block: "nearest" });
  }, [ws.id, kind]);
  useEffect(() => {
    window.addEventListener("panel-focus", take);
    return () => window.removeEventListener("panel-focus", take);
  }, [take]);
  useEffect(take);

  // A dragover anywhere this tree did not accept takes its mark off, and so
  // does the end of the drag. A drag from another application is followed
  // through Tauri instead: the Workspace window says which row it is over,
  // and what was dropped there.
  useEffect(() => {
    const unmark = () => { setDropDir(null); setDragOver(null); };
    const over = (e: DragEvent) => { if (treeDrag() && marked.current !== e) unmark(); };
    document.addEventListener("dragover", over);
    const off = onDropEnd(unmark);
    return () => { document.removeEventListener("dragover", over); off(); };
  }, []);
  useEffect(() => {
    const folderOf = (el: Element | null) => (el && body.current?.contains(el) ? el.getAttribute("data-drop-dir") : null);
    const over = (e: Event) => setDropDir(folderOf((e as CustomEvent<Element | null>).detail));
    const dropIn = (e: Event) => {
      const { el, paths } = (e as CustomEvent<{ el: Element; paths: string[] }>).detail;
      const dir = folderOf(el);
      // From outside a file is copied, never moved.
      if (dir !== null) void transfer(paths, dir, false);
    };
    window.addEventListener("tree-drop-over", over);
    window.addEventListener("tree-drop-in", dropIn);
    return () => {
      window.removeEventListener("tree-drop-over", over);
      window.removeEventListener("tree-drop-in", dropIn);
    };
  });
  const refilter = (value: string) => {
    setFilter(value);
    // The file list is read once per filter session; the next one reads it afresh.
    if (!value) setAllFiles(null);
  };

  const content = kind === "custom" && !view ? null
    : view ? (filter ? renderFilteredView() : renderView())
    : filter ? (filtered ? renderFiltered("", 0, -1, null) : <div className="tree-loading loading">Loading…</div>)
    : render("", 0, -1, null);
  const creation = creationDir();
  const create = (kind: "new-file" | "new-folder") => { if (creation !== null) setDialog({ kind, dir: creation }); };

  /** A row's own menu; with the row in a selection of several, its actions take them all. */
  const rowMenu = (r: TreeRow) => {
    const e = r.entry;
    const many = taking(r);
    const several = many.length > 1;
    const paths = many.map((x) => x.path);
    return (
      <>
        <hr />
        <button onClick={() => { onQuote(many.map(citation)); setMenu(null); }}>Quote to AI{several ? ` (${many.length} files)` : ""}</button>
        {/* The selection goes in tree order, as one change, less what the view holds already (TREE-28). */}
        <SubMenu label="Send to view">
          {ws.views.map((v) => {
            const adding = paths.filter((p) => !v.entries.includes(p));
            return (
              <button key={v.id} disabled={!adding.length} onClick={() => { void api.viewAdd(ws.id, v.id, adding).catch(report); setMenu(null); }}>
                <span className="menu-label">{v.name}</span>{!adding.length && <span className="menu-hint">already there</span>}
              </button>
            );
          })}
          {ws.views.length > 0 && <hr />}
          <button onClick={() => { setDialog({ kind: "new-view", then: paths }); setMenu(null); }}>New view…</button>
        </SubMenu>
        <hr />
        <button onClick={() => { copy(false); setMenu(null); }}>Copy</button>
        <button onClick={() => { copy(true); setMenu(null); }}>Cut</button>
        {hasFiles && <button onClick={() => { void paste(targetDir()); setMenu(null); }}>Paste into {e.isDir ? e.name : dirOf(e.path) || "the root"}</button>}
        <hr />
        <button disabled={several} onClick={() => { setDialog({ kind: "rename", entry: e }); setMenu(null); }}>Rename…</button>
        <button disabled={several} onClick={() => { void api.duplicateEntry(ws.id, e.path).catch(report); setMenu(null); }}>Duplicate</button>
        <button onClick={() => { void remove(many, false); setMenu(null); }}>Move to trash</button>
        <hr />
        <button onClick={() => { void api.copyText(e.path); setMenu(null); }}>Copy relative path</button>
        <button onClick={() => { void api.copyText(`${ws.path}/${e.path}`); setMenu(null); }}>Copy absolute path</button>
        <button onClick={() => { void api.revealEntry(ws.id, e.path).catch(report); setMenu(null); }}>Reveal in file manager</button>
        {/* A new terminal of this workspace, started in the folder, with its window brought forward on it (TREE-17). */}
        {e.isDir && <button onClick={() => { void api.terminalOpen(ws.id, e.path).then(() => api.focusWindow("terminal")).catch(report); setMenu(null); }}>Open terminal here</button>}
      </>
    );
  };

  return (
    <div className="sidebar-body" ref={body}>
      {kind === "custom" && !view ? (
        <div className="panel-empty">
          No custom views yet. A view gathers files and folders from anywhere in the workspace at its root: right-click one in Explorer and choose “Send to view”.
          <div><button onClick={() => setDialog({ kind: "new-view" })}>New view…</button></div>
        </div>
      ) : (
        <>
          <div className="tree-head">
            {view && (
              <RowMenu
                label={view.name}
                title={`View: ${view.name}`}
                minWidth={220}
                rows={ws.views.map((v) => ({
                  id: v.id,
                  name: v.name,
                  selected: v.id === view.id,
                  onPick: () => void api.setActiveView(ws.id, v.id).catch(report),
                  onRename: () => setDialog({ kind: "rename-view", view: v }),
                  onRemove: () => void deleteView(v),
                }))}
                footer={{ label: "＋ New view…", onClick: () => setDialog({ kind: "new-view" }) }}
              />
            )}
            <span className="tree-tools">
              <button onClick={() => create("new-file")} disabled={creation === null} title={creation === null ? "Select a folder in the view first" : `New file in ${creation || "the workspace root"}`}><Icon name="newFile" /></button>
              <button onClick={() => create("new-folder")} disabled={creation === null} title={creation === null ? "Select a folder in the view first" : `New folder in ${creation || "the workspace root"}`}><Icon name="newFolder" /></button>
            </span>
          </div>
          <input
            className="tree-filter"
            placeholder="Filter files"
            value={filter}
            onChange={(e) => refilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") refilter(""); }}
          />
          <nav
            ref={scroller}
            className={`tree${dropDir === "" ? " drop-into" : ""}`}
            tabIndex={0}
            role="tree"
            aria-label={view ? `View: ${view.name}` : "Explorer"}
            aria-multiselectable="true"
            aria-activedescendant={leadId}
            data-kind={kind}
            // The Explorer's background is its root; a view's is no folder at all (VIEW-06).
            data-drop-dir={view ? undefined : ""}
            onDragOver={(ev) => { const drag = treeDrag(); if (drag && !view && !(ev.target as Element).closest(".tree-row")) aimInto(ev, drag, ""); }}
            onKeyDown={onKey}
            onMouseDown={(e) => { if (e.target === e.currentTarget) setSel(selection.NONE); }}
            onContextMenu={(ev) => { ev.preventDefault(); openMenu({ x: ev.clientX, y: ev.clientY, row: null }); }}
          >
            {content}
          </nav>
        </>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu} onClose={() => setMenu(null)}>
          {/* A view's root is a list of shortcuts, not a directory: nothing new is created there (VIEW-06). */}
          {(!view || menu.row) && !menu.row?.entry.missing && (
            <>
              <button onClick={() => { setDialog({ kind: "new-file", dir: targetDir() }); setMenu(null); }}>New file…</button>
              <button onClick={() => { setDialog({ kind: "new-folder", dir: targetDir() }); setMenu(null); }}>New folder…</button>
            </>
          )}
          {!menu.row && hasFiles && creation !== null && (
            <button onClick={() => { void paste(); setMenu(null); }}>Paste</button>
          )}
          {view && !menu.row && (
            <>
              <button onClick={() => { setDialog({ kind: "new-view" }); setMenu(null); }}>New view…</button>
              <button onClick={() => { setDialog({ kind: "rename-view", view }); setMenu(null); }}>Rename view…</button>
              <button onClick={() => { void deleteView(view); setMenu(null); }}>Delete view</button>
            </>
          )}
          {/* Every selected path that is one of the view's entries leaves it, as one change (TREE-28). */}
          {menu.row?.viewRoot && view && (
            <>
              <hr />
              <button onClick={() => { void api.viewRemove(ws.id, view.id, taking(menu.row!).map((r) => r.path).filter((p) => view.entries.includes(p))).catch(report); setMenu(null); }}>Remove from view</button>
            </>
          )}
          {menu.row && !menu.row.entry.missing && rowMenu(menu.row)}
        </ContextMenu>
      )}
      {dialog && (
        <Prompt
          title={
            dialog.kind === "new-file" ? "New file name"
              : dialog.kind === "new-folder" ? "New folder name"
              : dialog.kind === "new-view" ? "Name for the new view"
              : dialog.kind === "rename-view" ? "New name for the view"
              : "New name"
          }
          initial={dialog.kind === "rename" ? dialog.entry.name : dialog.kind === "rename-view" ? dialog.view.name : ""}
          selectEnd={dialog.kind === "rename" && !dialog.entry.isDir && dialog.entry.name.lastIndexOf(".") > 0 ? dialog.entry.name.lastIndexOf(".") : undefined}
          onSubmit={(v) => void submitDialog(v)}
          onClose={() => setDialog(null)}
        />
      )}
      {asking && (
        <Confirm
          title={asking.title}
          message={asking.message}
          checkbox={asking.checkbox}
          ok={asking.ok}
          cancel={asking.cancel}
          alt={asking.alt}
          onClose={(ok, checked, alt) => { setAsking(null); asking.answer({ ok, checked, alt }); }}
        />
      )}
    </div>
  );
}
