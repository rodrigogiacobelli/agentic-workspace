// Mirrors the backend's serialised structs field for field (state.rs).

export interface Session {
  version: number;
  workspaces: Workspace[];
  active: string | null;
  /** Workspace ids, most recently used first. */
  recent: string[];
}

export interface Workspace {
  id: string;
  path: string;
  name: string;
  terminals: TerminalTab[];
  activeTerminal: string | null;
  /** Every editor group; `layout` arranges them. Never empty. */
  groups: EditorGroup[];
  activeGroup: string | null;
  /** A tree of rows and columns whose leaves name the groups. */
  layout: Layout;
  /** Expanded tree directories, relative to `path`. */
  expanded: string[];
  /** Recently opened files, relative to `path`, most recent first. */
  recentFiles: string[];
  /** Custom views: named lists of workspace-relative paths. */
  views: View[];
  /** The view the Files panel shows; null is the tree itself. */
  activeView: string | null;
  available: boolean;
  /** A background terminal here printed since it was last viewed. */
  attention: boolean;
  git: GitSummary | null;
  /** Opened from a repository's worktree list rather than named by the user. */
  fromWorktree: boolean;
}

/** A split node, shared by the editor layout and the panel layout. */
export interface Split<L> {
  kind: "split";
  direction: "row" | "column";
  children: (L | Split<L>)[];
  sizes: number[];
}

export interface LayoutGroup { kind: "group"; id: string }
export type Layout = LayoutGroup | Split<LayoutGroup>;

export type PanelId = "files" | "search" | "git" | "outline";
export interface Region { kind: "region"; id: string; panels: PanelId[]; active: PanelId }
export interface EditorLeaf { kind: "editor" }
export type DockLeaf = Region | EditorLeaf;
export type DockNode = DockLeaf | Split<DockLeaf>;

/** Where the panels sit around the editor; the application's, not a workspace's. */
export interface PanelLayout {
  root: DockNode;
  hidden: PanelId[];
  /** The region each hidden panel left, so it returns there. */
  lastRegion: Partial<Record<PanelId, string>>;
}

export interface View {
  id: string;
  name: string;
  entries: string[];
}

export interface GitSummary {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  state: string | null;
  isWorktree: boolean;
  /** Every other worktree of this repository, as git lists them. */
  worktrees: Worktree[];
}

/** A sibling worktree offered under its workspace in the selector. */
export interface Worktree {
  /** Absolute. */
  path: string;
  name: string;
  branch: string | null;
  isMain: boolean;
}

export interface TerminalTab {
  id: string;
  name: string | null;
  cwd: string;
  attention: boolean;
}

export interface EditorGroup {
  id: string;
  editors: EditorTab[];
  activeEditor: string | null;
}

export interface EditorTab {
  id: string;
  path: string;
  /** `source`, `split` or `rich`; meaningful for markdown only. */
  mode: string;
  /** First visible line, restored on reopen. */
  line: number;
  /** Set when the tab shows a diff of `path` rather than the file. */
  diff: DiffSpec | null;
  /** A preview tab: one per group, replaced by the next single click. */
  preview: boolean;
}

export interface DiffSpec {
  kind: "worktree" | "staged" | "commit";
  hash: string | null;
  untracked: boolean;
}

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
  /** The path no longer exists; a view or a citation still names it. */
  missing?: boolean;
}

export interface DirChanged {
  workspaceId: string;
  dirs: string[];
}

export type WindowRole = "workspace" | "terminal";

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface WorkspaceSettings {
  clipboardDir: string | null;
  notifications: boolean | null;
  theme: string | null;
}

export interface Settings {
  version: number;
  theme: string;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  editorFontFamily: string;
  editorFontSize: number;
  proseFontFamily: string;
  proseFontSize: number;
  autosave: boolean;
  autosaveDelayMs: number;
  notifications: boolean;
  quietThresholdS: number;
  assetWarnMb: number;
  /** What paste and drop write: a note-relative markdown link, or an `@/` citation. */
  assetLinks: "markdown" | "citation";
  globalHotkey: string;
  languages: Record<string, string>;
  /** How a panel's tab reads. */
  panelTabs: "text" | "icons";
  /** The mode a markdown file opens in. */
  markdownMode: "source" | "split" | "rich";
  /** The program a terminal tab runs; empty means `$SHELL`. */
  terminalShell: string;
  /** Which renderer a terminal draws with. */
  terminalGpu: "auto" | "webgl" | "dom";
  panelLayout: PanelLayout | null;
  workspaces: Record<string, WorkspaceSettings>;
}

export interface StoredAsset {
  path: string;
  link: string;
  bytes: number;
}

export interface RepoInfo {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  state: string | null;
  isWorktree: boolean;
  mainWorktree: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface StatusEntry {
  path: string;
  origPath: string | null;
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface LogEntry {
  hash: string;
  subject: string;
  author: string;
  date: string;
  timestamp: number;
  /** Subject and body together, shown in the history's hover popup. */
  message: string;
}

export interface CommitDetail {
  hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  files: { status: string; path: string }[];
}

export interface BlameLine {
  line: number;
  hash: string;
  short: string;
  author: string;
  date: string;
}

export interface Branch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  worktree: string | null;
}

export interface Branches {
  local: Branch[];
  remote: string[];
}

/** What the desktop clipboard holds when it holds files, with absolute paths. */
export interface ClipboardFiles {
  paths: string[];
  cut: boolean;
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
  bare: boolean;
}

export interface HotkeyStatus {
  active: boolean;
  trigger: string | null;
  message: string | null;
}

export interface ImportedTheme {
  id: string;
  name: string;
  dark: boolean;
  ui: Record<string, string>;
  terminal: Record<string, string>;
  syntax: Record<string, string>;
  report: string[];
}
