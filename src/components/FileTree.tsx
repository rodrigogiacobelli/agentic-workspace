import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { api, events } from "../api";
import { offerDrop, onDropEnd, startTreeDrag, treeDrag, type DropAction, type TreeDrag } from "../dropRoute";
import * as editors from "../editors";
import { keep, peek, useKept, useKeptScroll, useLive } from "../live";
import type { Entry, StatusEntry, View, Workspace } from "../types";
import { fileIcon, Icon } from "./icons";
import { ContextMenu, RowMenu, SubMenu } from "./Menu";
import { Prompt } from "./Prompt";
import { FILE_MIME } from "./SplitTree";
import { duration } from "../motion";
import { report } from "../notice";

interface Props {
  ws: Workspace;
  /** The workspace's own tree, or its custom views. */
  kind: "explorer" | "custom";
  /** A single click opens a preview tab; a double click or a new file opens a permanent one. */
  onOpen: (path: string, preview: boolean) => void;
  /** Inserts a citation of each path into the active document, one per line. */
  onQuote: (paths: string[]) => void;
  selected: string | null;
  onSelect: (path: string | null) => void;
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

interface Menu {
  x: number;
  y: number;
  entry: Entry | null;
  /** The row is one of the open view's own entries. */
  viewRoot: boolean;
}

type Dialog =
  | { kind: "new-file"; dir: string }
  | { kind: "new-folder"; dir: string }
  | { kind: "rename"; entry: Entry }
  | { kind: "new-view"; then?: string }
  | { kind: "rename-view"; view: View };

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

/**
 * A row asked for from outside the tree: a breadcrumb's Reveal in Explorer
 * (ED-47). Held here rather than in a tree, since the Explorer it names may be
 * built only once the request has brought it forward.
 */
let revealing: { workspaceId: string; path: string } | null = null;
window.addEventListener("tree-reveal", (e) => { revealing = (e as CustomEvent<{ workspaceId: string; path: string }>).detail; });

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
 * listings, filter, view entries, multi-selection and scroll are kept per
 * workspace and kind, so the tree built again paints as it was left, then
 * reads what it draws afresh — it heard no change while it was down.
 */
export function FileTree({ ws, kind, onOpen, onQuote, selected, onSelect, gitStatus = [] }: Props) {
  const gitMap = useMemo(() => statusMap(gitStatus), [gitStatus]);
  const kept = `${ws.id}:tree:${kind}`;
  const [listings, setListings] = useKept(`${kept}:listings`, NOTHING);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [filter, setFilter] = useKept(`${kept}:filter`, "");
  const [allFiles, setAllFiles] = useKept<string[] | null>(`${kept}:files`, null);
  const [viewEntries, setViewEntries] = useKept<Entry[] | null>(`${kept}:view`, null);
  /** Ctrl+click adds rows to a selection that Quote to AI cites together (CITE-13). */
  const [multi, setMulti] = useKept<Set<string>>(`${kept}:multi`, new Set());
  /** Every row drawn in this render, in tree order. */
  const order = useRef<string[]>([]);
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
  // Custom shows the view last picked, or the first there is.
  const view = kind === "custom" ? (ws.views.find((v) => v.id === ws.activeView) ?? ws.views[0] ?? null) : null;
  const entriesKey = view?.entries.join("\n") ?? "";
  const roots = view?.entries ?? null;
  /** What callbacks outliving a render read: the workspace, its expansion and the view's entries as of the last one. */
  const latest = useRef({ ws, expanded: ws.expanded, roots });
  latest.current = { ws, expanded: ws.expanded, roots };

  // A listing that comes back as it was changes nothing and draws nothing; one
  // for a directory folded while it was read is dropped.
  const load = useCallback((dir: string) => {
    if (inflight.current.has(dir)) return;
    inflight.current.add(dir);
    api.listDir(ws.id, dir)
      .then((entries) => setListings((m) => {
        if (dir && !latest.current.expanded.includes(dir)) return m;
        return same(m.get(dir), entries) ? m : new Map(m).set(dir, entries);
      }))
      // A directory deleted while it was open stays in the expanded set, and
      // every build would report it again; it is folded instead.
      .catch((e) => {
        if (dir && /No such file|os error 2/i.test(String(e))) void api.setExpanded(ws.id, dir, false).catch(() => {});
        else report(e);
      })
      .finally(() => inflight.current.delete(dir));
  }, [ws.id, setListings]);

  const loadView = useCallback(() => {
    if (!view) { setViewEntries(null); return; }
    api.statEntries(ws.id, view.entries).then((e) => setViewEntries((prev) => (same(prev, e) ? prev : e))).catch(report);
  }, [ws.id, view?.id, entriesKey, setViewEntries]); // eslint-disable-line react-hooks/exhaustive-deps

  // Built, the tree reads its root and every directory it draws open, and a
  // filter's file list: it heard nothing while it was down, and it paints
  // from what it kept until the answers land. A directory opened after that is
  // read as it opens. A file list dropped meanwhile, with its filter, stays
  // dropped.
  const expandedKey = ws.expanded.join("\n");
  const built = useRef(false);
  /** What the last pass drew: a directory coming into view is read even with a
   *  listing kept, which the other tree may have folded and let go stale. */
  const wasDrawn = useRef(new Set<string>());
  useEffect(() => {
    const all = !built.current;
    built.current = true;
    if (all && kind === "explorer") load("");
    const now = drawn(ws.expanded, roots);
    for (const dir of now) if (all || !wasDrawn.current.has(dir)) load(dir);
    wasDrawn.current = new Set(now);
    if (all && filter && allFiles !== null) refetchFiles(0);
  }, [expandedKey, entriesKey, load]); // eslint-disable-line react-hooks/exhaustive-deps

  // A filter's file list is read again after a change, and the kept one paints
  // until the answer lands. An agent writing in a watched directory reports a
  // change several times a second, and every read walks the whole tree, so the
  // changes of a second share one read; only the latest read asked for lands.
  const filesRead = useRef<{ timer: number | null; asked: number }>({ timer: null, asked: 0 });
  const refetchFiles = (delay: number) => {
    const read = filesRead.current;
    if (read.timer !== null) return;
    read.timer = window.setTimeout(() => {
      read.timer = null;
      const asked = ++read.asked;
      api.listFiles(ws.id)
        .then((files) => { if (read.asked === asked) setAllFiles((prev) => (prev === null || same(prev, files) ? prev : files)); })
        .catch(report);
    }, delay);
  };
  useEffect(() => () => { if (filesRead.current.timer !== null) window.clearTimeout(filesRead.current.timer); }, []);

  useEffect(() => { loadView(); }, [loadView]);

  // A directory that leaves the expanded set keeps its children on screen for
  // as long as the collapse takes; React would otherwise take them away before
  // the first frame of it. Then its listing goes, with those of the
  // directories inside it, and is read afresh when it opens again. The timer
  // runs out even when another directory folds meanwhile.
  const wasExpanded = useRef(ws.expanded);
  useEffect(() => {
    const gone = wasExpanded.current.filter((d) => !ws.expanded.includes(d));
    wasExpanded.current = ws.expanded;
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
  const opened = built.current ? ws.expanded.filter((d) => !wasExpanded.current.includes(d)) : [];
  const toggle = (path: string) => void api.setExpanded(ws.id, path, !ws.expanded.includes(path));

  // Filtered view: matching files and their ancestors, every directory open.
  const filtered = useMemo(() => {
    if (!filter || !allFiles) return null;
    const needle = filter.toLowerCase();
    const roots = view?.entries ?? null;
    const matches = allFiles
      .filter((p) => p.toLowerCase().includes(needle))
      .filter((p) => !roots || roots.some((r) => p === r || p.startsWith(`${r}/`)))
      .slice(0, 2000);
    const children = new Map<string, Map<string, boolean>>();
    for (const file of matches) {
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

  /** Whether a path shown in the panel is a directory. A filtered tree draws folders it never listed. */
  const isDir = (path: string): boolean =>
    filtered?.get(dirOf(path))?.get(path.slice(path.lastIndexOf("/") + 1)) === true ||
    viewEntries?.find((e) => e.path === path)?.isDir || [...listings.values()].some((l) => l.some((e) => e.path === path && e.isDir));

  /** Where a new file or folder goes: inside the selected folder, beside the selected file, else the root. */
  const creationDir = (): string | null => {
    if (selected) return isDir(selected) ? selected : dirOf(selected);
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

  const contextTarget = (): Entry | null => menu?.entry ?? null;
  const targetDir = (): string => {
    const e = contextTarget();
    return e ? (e.isDir ? e.path : dirOf(e.path)) : "";
  };

  const trash = async (paths: string[]) => {
    if (!paths.length) return;
    const what = paths.length === 1 ? paths[0] : `${paths.length} items`;
    const yes = await ask(`Move ${what} to the trash?`, { title: "Delete", kind: "warning", okLabel: "Move to trash", cancelLabel: "Keep" });
    if (!yes) return;
    for (const p of paths) await api.trashEntry(ws.id, p).catch(report);
    setMulti(new Set());
  };

  /** The rows a keyboard action applies to: the multi-selection in tree order, else the selected row. */
  const targets = (): string[] => (multi.size > 0 ? order.current.filter((p) => multi.has(p)) : selected ? [selected] : []);

  /**
   * Copy and cut go to the desktop's clipboard, not a variable of this module.
   * One clipboard is what makes the newest copy win whichever window made it,
   * and it is the same clipboard a file manager pastes from (FIX-12).
   */
  const copy = (cut: boolean) => {
    const paths = targets();
    if (paths.length) void api.setClipboardFiles(paths.map((p) => `${ws.path}/${p}`), cut).then(() => holdsFiles(true)).catch(report);
  };

  /**
   * Before a Replace, the tabs open on what is replaced or on anything in it:
   * a clean one is closed, and one with unsaved changes stops the Replace,
   * since its buffer would outlive its file. A tab not opened this session
   * keeps its unsaved changes as a draft, which would be laid over whatever
   * lands at its path the next time it opens.
   */
  const closeTabsUnder = async (dest: string): Promise<boolean> => {
    const w = latest.current.ws;
    const tabs = [...w.groups, ...w.review.groups].flatMap((g) => g.editors).filter((t) => t.path === dest || t.path.startsWith(`${dest}/`));
    const drafted = await Promise.all(tabs.map((t) => !editors.get(t.id) && api.readDraft(w.id, t.path).then((d) => d !== null, () => false)));
    const dirty = tabs.find((t, i) => editors.isDirty(t.id) || drafted[i]);
    if (dirty) {
      report(`${dirty.path} has unsaved changes, so ${dest} was not replaced.`);
      return false;
    }
    for (const t of tabs) await api.closeFile(w.id, t.id);
    return true;
  };

  /**
   * Puts one absolute path into `dir`, asking first when its name is taken
   * there (TREE-12). Answers where it landed, null when it stayed where it
   * was, or "stop" when the answer was to cancel the rest.
   */
  const place = async (from: string, dir: string, cut: boolean): Promise<string | null | "stop"> => {
    const first = await api.pasteEntry(ws.id, from, dir, cut, "ask");
    if (!first.exists) return first.path;
    const dest = join(dir, from.slice(from.lastIndexOf("/") + 1));
    // Pasted where it already is, a copy takes a free name beside itself, as Duplicate does.
    if (from === `${ws.path}/${dest}`) return (await api.pasteEntry(ws.id, from, dir, cut, "keep")).path;
    const answer = await message(`${dest} already exists. Replace it, sending the one there to the trash, or keep both?`, {
      title: "Name taken",
      kind: "warning",
      buttons: { yes: "Replace", no: "Keep both", cancel: "Cancel" },
    });
    if (answer === "Keep both") return (await api.pasteEntry(ws.id, from, dir, cut, "keep")).path;
    if (answer !== "Replace") return "stop";
    if (!(await closeTabsUnder(dest))) return null;
    return (await api.pasteEntry(ws.id, from, dir, cut, "replace")).path;
  };

  const undoKey = `${ws.id}:tree:undo`;

  /**
   * Copies, or moves when `cut`, absolute paths into the folder `dir`: the
   * clipboard's paste, a drop from a tree and a drop from another
   * application. The folder then opens and is read — a folded one is not
   * watched — and the last entry to land is selected. The moves made inside
   * the workspace are kept together for Ctrl+Z (TREE-13).
   */
  const transfer = async (paths: string[], dir: string, cut: boolean): Promise<void> => {
    let last: string | null = null;
    const moved: Move[] = [];
    for (const from of paths) {
      let to: string | null;
      try {
        const landed = await place(from, dir, cut);
        if (landed === "stop") break;
        to = landed;
      } catch (e) {
        report(e);
        continue;
      }
      if (to === null) continue;
      last = to;
      const rel = from.startsWith(`${ws.path}/`) ? from.slice(ws.path.length + 1) : null;
      if (cut && rel !== null && rel !== to) moved.push({ from: rel, to });
    }
    if (moved.length) keep(undoKey, [...(peek<Move[][]>(undoKey) ?? []), moved].slice(-UNDO_DEPTH));
    if (dir && !latest.current.expanded.includes(dir)) await api.setExpanded(ws.id, dir, true).catch(() => {});
    load(dir);
    if (last) {
      setMulti(new Set());
      onSelect(last);
    }
  };

  /** Ctrl+Z: the last batch of moves goes back where it came from. A place taken since keeps what is there. */
  const undoMoves = async () => {
    const stack = peek<Move[][]>(undoKey) ?? [];
    const batch = stack[stack.length - 1];
    if (!batch) return;
    keep(undoKey, stack.slice(0, -1));
    for (const { from, to } of [...batch].reverse()) {
      await api.renameEntry(ws.id, to, from).catch((e) => report(/already exists/.test(String(e)) ? `${from} is taken now, so ${to} stays where it is.` : e));
    }
  };

  const paste = async () => {
    const dir = creationDir();
    if (dir === null) return;
    const { paths, cut } = await api.clipboardFiles().catch((e) => { report(e); return { paths: [], cut: false }; });
    if (!paths.length) return;
    await transfer(paths, dir, cut);
    // The files are no longer where the cut says they are.
    if (cut) { await api.clearClipboardFiles().catch(() => {}); holdsFiles(false); }
  };

  const entryOf = (path: string): Entry => ({ name: path.split("/").pop() ?? path, path, isDir: isDir(path), ignored: false });

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.ctrlKey && !e.altKey && !e.shiftKey && key === "c") copy(false);
    else if (e.ctrlKey && !e.altKey && !e.shiftKey && key === "x") copy(true);
    else if (e.ctrlKey && !e.altKey && !e.shiftKey && key === "v") void paste();
    else if (e.ctrlKey && !e.altKey && !e.shiftKey && key === "z") void undoMoves();
    else if (!e.ctrlKey && e.key === "Delete") void trash(targets());
    else if (!e.ctrlKey && e.key === "F2" && selected) setDialog({ kind: "rename", entry: entryOf(selected) });
    else if (!e.ctrlKey && e.key === "Enter" && selected) { if (isDir(selected)) toggle(selected); else onOpen(selected, false); }
    else if (e.key === "Escape") setMulti(new Set());
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
        if (d.dir && !ws.expanded.includes(d.dir)) await api.setExpanded(ws.id, d.dir, true);
        load(d.dir);
        if (d.kind === "new-file") onOpen(path, false);
      } else if (d.kind === "rename") {
        await api.renameEntry(ws.id, d.entry.path, join(dirOf(d.entry.path), value));
      } else if (d.kind === "new-view") {
        const id = await api.viewCreate(ws.id, value);
        if (d.then) await api.viewAdd(ws.id, id, d.then);
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
  const dragFrom = (ev: React.DragEvent, e: Entry) => {
    // The whole multi-selection travels when the row is in it, in tree order.
    const paths = multi.has(e.path) ? targets() : [e.path];
    const abs = paths.map((p) => `${ws.path}/${p}`);
    const missing = paths.some((p) => !!(p === e.path ? e.missing : viewEntries?.find((v) => v.path === p)?.missing));
    // One entry carries its file for other applications (TREE-15). WebKit
    // runs several URIs together into one, so a selection carries none.
    const uri = paths.length === 1 && !missing;
    startTreeDrag({
      workspaceId: ws.id,
      paths,
      abs,
      dirs: new Set(paths.filter((p) => (p === e.path ? e.isDir : isDir(p)))),
      roots: view && paths.every((p) => view.entries.includes(p)) ? view.id : null,
      missing,
      uri,
    });
    // WebKitGTK starts no drag without data; nothing reads this back.
    ev.dataTransfer.setData(FILE_MIME, paths.join("\n"));
    if (uri) ev.dataTransfer.setData("text/uri-list", fileUri(abs[0]));
    ev.dataTransfer.effectAllowed = "copyMove";
  };

  const row = (e: Entry, depth: number, expanded: boolean, onClick: () => void, viewRoot = false) => {
    order.current.push(e.path);
    const icon = fileIcon(e.name, e.isDir, expanded);
    return (
      <div
        data-path={e.path}
        data-drop-dir={dropDirOf(e, viewRoot) ?? undefined}
        className={`tree-row${e.ignored ? " ignored" : ""}${e.missing ? " missing" : ""}${selected === e.path || multi.has(e.path) ? " selected" : ""}${dragOver === e.path ? " drop-before" : ""}${e.isDir && dropDir === e.path ? " drop-into" : ""}${gitMap.has(e.path) ? ` git-${gitMap.get(e.path)}` : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(ev) => {
          if (ev.ctrlKey) {
            setMulti((m) => { const next = new Set(m); if (next.has(e.path)) next.delete(e.path); else next.add(e.path); if (selected && !next.has(selected)) next.add(selected); return next; });
            onSelect(e.path);
            return;
          }
          setMulti(new Set());
          onClick();
        }}
        onDoubleClick={() => { if (!e.isDir && !e.missing) onOpen(e.path, false); }}
        // A missing entry at a view's root still drags, to be reordered.
        draggable={viewRoot || !e.missing}
        onDragStart={(ev) => dragFrom(ev, e)}
        onDragOver={(ev) => { const drag = treeDrag(); if (drag) aimRow(ev, drag, e, viewRoot); }}
        onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); if (!multi.has(e.path)) { setMulti(new Set()); onSelect(e.path); } openMenu({ x: ev.clientX, y: ev.clientY, entry: e, viewRoot }); }}
        title={e.missing ? `Missing: ${e.path}` : e.path}
      >
        <span className={`tree-chevron${expanded ? " open" : ""}`}>{e.isDir ? "▸" : ""}</span>
        <Icon name={icon.name} color={e.ignored || e.missing ? undefined : icon.color} />
        <span className="tree-name">{e.missing ? e.path : e.name}</span>
        {gitMap.has(e.path) && <span className="tree-git">{e.isDir ? "•" : gitMap.get(e.path)}</span>}
      </div>
    );
  };

  /** A directory's children, revealed and hidden by their own height (§11.3). */
  const branch = (path: string, open: boolean, children: React.ReactNode): React.ReactNode =>
    open || collapsing.has(path) ? (
      <div className={`tree-branch${open ? " open" : ""}${opened.includes(path) ? " unfold" : ""}`}><div>{children}</div></div>
    ) : null;

  const render = (dir: string, depth: number): React.ReactNode => {
    const entries = listings.get(dir);
    if (!entries) return depth === 0 ? <div className="tree-loading loading">Loading…</div> : null;
    return entries.map((e) => {
      const expanded = e.isDir && ws.expanded.includes(e.path);
      return (
        <div key={e.path}>
          {row(e, depth, expanded, () => { onSelect(e.path); if (e.isDir) toggle(e.path); else onOpen(e.path, true); })}
          {branch(e.path, expanded, render(e.path, depth + 1))}
        </div>
      );
    });
  };

  // A view's root: its entries in order, each expanding to real children.
  const renderView = (): React.ReactNode => {
    if (!viewEntries) return <div className="tree-loading loading">Loading…</div>;
    if (viewEntries.length === 0) return <div className="tree-loading">Nothing has been sent to this view yet. Right-click a file or folder in Explorer and choose “Send to view”.</div>;
    return viewEntries.map((e) => {
      const expanded = e.isDir && ws.expanded.includes(e.path);
      const open = () => { onSelect(e.path); if (e.missing) return; if (e.isDir) toggle(e.path); else onOpen(e.path, true); };
      return (
        <div key={e.path}>
          {row(e, 0, expanded, open, true)}
          {branch(e.path, expanded, listings.has(e.path) ? render(e.path, 1) : (load(e.path), null))}
        </div>
      );
    });
  };

  const renderFiltered = (dir: string, depth: number): React.ReactNode => {
    const kids = filtered?.get(dir);
    if (!kids) return null;
    return [...kids.entries()]
      .sort(([a, ad], [b, bd]) => Number(bd) - Number(ad) || a.localeCompare(b))
      .map(([name, isDirectory]) => {
        const e: Entry = { name, path: join(dir, name), isDir: isDirectory, ignored: false };
        return (
          <div key={e.path}>
            {row(e, depth, true, () => { onSelect(e.path); if (!e.isDir) onOpen(e.path, true); })}
            {isDirectory && renderFiltered(e.path, depth + 1)}
          </div>
        );
      });
  };

  // A filtered view keeps its entries at the root and filters beneath them.
  const renderFilteredView = (): React.ReactNode => {
    if (!filtered || !viewEntries) return <div className="tree-loading loading">Loading…</div>;
    return viewEntries
      .filter((e) => e.isDir ? filtered.has(e.path) : e.path.toLowerCase().includes(filter.toLowerCase()))
      .map((e) => (
        <div key={e.path}>
          {row(e, 0, true, () => { onSelect(e.path); if (!e.isDir && !e.missing) onOpen(e.path, true); }, true)}
          {e.isDir && renderFiltered(e.path, 1)}
        </div>
      ));
  };

  const citation = (e: Entry) => (e.isDir ? `${e.path}/` : e.path);
  /** What Quote to AI cites: the multi-selection in tree order, or the one row. */
  const quoteTargets = (e: Entry): string[] => {
    if (multi.size > 1 && multi.has(e.path)) {
      return order.current.filter((p) => multi.has(p)).map((p) => (isDir(p) ? `${p}/` : p));
    }
    return [citation(e)];
  };
  order.current = [];

  const scroller = useKeptScroll<HTMLElement>(`${kept}:scroll`, view ? viewEntries !== null : listings.has(""));
  // A revealed row is scrolled to once the folders above it have opened and it
  // is drawn; behind another panel's tab it has no box yet, and waits. One the
  // reader has since moved away from is dropped rather than paid later.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const want = revealing;
    if (kind !== "explorer" || !want || want.workspaceId !== ws.id) return;
    if (selected !== want.path) { revealing = null; return; }
    const row = body.current?.querySelector(`[data-path="${CSS.escape(want.path)}"]`);
    if (!row?.getClientRects().length) return;
    revealing = null;
    row.scrollIntoView({ block: "nearest" });
    // A folder just opened is still unfolding, and its clipped rows do not yet
    // count toward the height the tree scrolls through, so near the end the
    // scroll falls short of the row; it is made again once they do.
    const unfolding: Animation[] = [];
    for (let b = row.closest(".tree-branch"); b; b = b.parentElement?.closest(".tree-branch") ?? null) unfolding.push(...b.getAnimations());
    if (unfolding.length) void Promise.all(unfolding.map((a) => a.finished)).then(() => row.scrollIntoView({ block: "nearest" }), () => {});
  });
  // The request may change nothing the tree draws — the row already selected,
  // the Explorer already in front, every folder above it open — so it draws
  // again to look.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (kind !== "explorer") return;
    window.addEventListener("tree-reveal", redraw);
    return () => window.removeEventListener("tree-reveal", redraw);
  }, [kind]);

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

  const creation = creationDir();
  const create = (kind: "new-file" | "new-folder") => { if (creation !== null) setDialog({ kind, dir: creation }); };

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
            // The Explorer's background is its root; a view's is no folder at all (VIEW-06).
            data-drop-dir={view ? undefined : ""}
            onDragOver={(ev) => { const drag = treeDrag(); if (drag && !view && !(ev.target as Element).closest(".tree-row")) aimInto(ev, drag, ""); }}
            onKeyDown={onKey}
            onMouseDown={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
            onContextMenu={(ev) => { ev.preventDefault(); openMenu({ x: ev.clientX, y: ev.clientY, entry: null, viewRoot: false }); }}
          >
            {view
              ? (filter ? renderFilteredView() : renderView())
              : (filter ? (filtered ? renderFiltered("", 0) : <div className="tree-loading loading">Loading…</div>) : render("", 0))}
          </nav>
        </>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu} onClose={() => setMenu(null)}>
          {/* A view's root is a list of shortcuts, not a directory: nothing new is created there (VIEW-06). */}
          {(!view || menu.entry) && !menu.entry?.missing && (
            <>
              <button onClick={() => { setDialog({ kind: "new-file", dir: targetDir() }); setMenu(null); }}>New file…</button>
              <button onClick={() => { setDialog({ kind: "new-folder", dir: targetDir() }); setMenu(null); }}>New folder…</button>
            </>
          )}
          {!menu.entry && hasFiles && (!view || selected) && (
            <button onClick={() => { void paste(); setMenu(null); }}>Paste</button>
          )}
          {view && !menu.entry && (
            <>
              <button onClick={() => { setDialog({ kind: "new-view" }); setMenu(null); }}>New view…</button>
              <button onClick={() => { setDialog({ kind: "rename-view", view }); setMenu(null); }}>Rename view…</button>
              <button onClick={() => { void deleteView(view); setMenu(null); }}>Delete view</button>
            </>
          )}
          {menu.entry && menu.viewRoot && view && (
            <>
              <hr />
              <button onClick={() => { void api.viewRemove(ws.id, view.id, menu.entry!.path).catch(report); setMenu(null); }}>Remove from view</button>
            </>
          )}
          {menu.entry && !menu.entry.missing && (
            <>
              <hr />
              <button onClick={() => { onQuote(quoteTargets(menu.entry!)); setMenu(null); }}>Quote to AI{multi.size > 1 && multi.has(menu.entry.path) ? ` (${multi.size} files)` : ""}</button>
              <SubMenu label="Send to view">
                {ws.views.map((v) => {
                  const there = v.entries.includes(menu.entry!.path);
                  return (
                    <button key={v.id} disabled={there} onClick={() => { void api.viewAdd(ws.id, v.id, menu.entry!.path).catch(report); setMenu(null); }}>
                      <span className="menu-label">{v.name}</span>{there && <span className="menu-hint">already there</span>}
                    </button>
                  );
                })}
                {ws.views.length > 0 && <hr />}
                <button onClick={() => { setDialog({ kind: "new-view", then: menu.entry!.path }); setMenu(null); }}>New view…</button>
              </SubMenu>
              <hr />
              <button onClick={() => { copy(false); setMenu(null); }}>Copy</button>
              <button onClick={() => { copy(true); setMenu(null); }}>Cut</button>
              {hasFiles && <button onClick={() => { void paste(); setMenu(null); }}>Paste into {menu.entry.isDir ? menu.entry.name : dirOf(menu.entry.path) || "the root"}</button>}
              <hr />
              <button onClick={() => { setDialog({ kind: "rename", entry: menu.entry! }); setMenu(null); }}>Rename…</button>
              <button onClick={() => { void api.duplicateEntry(ws.id, menu.entry!.path).catch(report); setMenu(null); }}>Duplicate</button>
              <button onClick={() => { void trash(targets().includes(menu.entry!.path) ? targets() : [menu.entry!.path]); setMenu(null); }}>Move to trash</button>
              <hr />
              <button onClick={() => { void api.copyText(menu.entry!.path); setMenu(null); }}>Copy relative path</button>
              <button onClick={() => { void api.copyText(`${ws.path}/${menu.entry!.path}`); setMenu(null); }}>Copy absolute path</button>
              <button onClick={() => { void api.revealEntry(ws.id, menu.entry!.path).catch(report); setMenu(null); }}>Reveal in file manager</button>
              {/* A new terminal of this workspace, started in the folder, with its window brought forward on it (TREE-17). */}
              {menu.entry.isDir && <button onClick={() => { void api.terminalOpen(ws.id, menu.entry!.path).then(() => api.focusWindow("terminal")).catch(report); setMenu(null); }}>Open terminal here</button>}
            </>
          )}
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
    </div>
  );
}
