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
  /** The Editor's working area: every group; `layout` arranges them. Never empty. */
  groups: EditorGroup[];
  activeGroup: string | null;
  /** A tree of rows and columns whose leaves name the groups. */
  layout: Layout;
  /** Source Control's working area: groups of diff tabs, arranged the same way. */
  review: WorkArea;
  /** The mode the Workspace window shows for this workspace. */
  mode: DockedMode;
  /** Expanded tree directories, relative to `path`. */
  expanded: string[];
  /** Recently opened files, relative to `path`, most recent first. */
  recentFiles: string[];
  /** Custom views: named lists of workspace-relative paths. */
  views: View[];
  /** The view the Custom panel shows; null is the first there is. */
  activeView: string | null;
  available: boolean;
  /** A background terminal here printed since it was last viewed. */
  attention: boolean;
  git: GitSummary | null;
  /** Opened from a repository's worktree list rather than named by the user. */
  fromWorktree: boolean;
  /** The open workspace on this one's repository, when this one is a linked
   *  worktree of it; the switcher and the tray list it under that one. */
  worktreeOf: string | null;
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

/** Groups of tabs and the tree arranging them: a mode's working area. */
export interface WorkArea {
  groups: EditorGroup[];
  activeGroup: string | null;
  layout: Layout;
}

/** Which working area a tab lives in: the Editor's files or Source Control's diffs. */
export type AreaId = "editor" | "review";

/**
 * What the reader is doing. A mode owns its panels, its working area and its
 * dock tree; Terminal is a mode that lives in a window of its own.
 */
export type ModeId = "editor" | "scm" | "terminal";
/** The modes the Workspace window shows. */
export type DockedMode = "editor" | "scm";

export type EditorPanelId = "explorer" | "custom" | "search" | "outline";
export type ScmPanelId = "commit" | "history" | "worktrees" | "branches" | "tags";
export type PanelId = EditorPanelId | ScmPanelId;
export interface Region { kind: "region"; id: string; panels: PanelId[]; active: PanelId }
/** The working area as a dock leaf. A panel dropped on its centre becomes one of its tabs. */
export interface WorkLeaf { kind: "work"; panels: PanelId[]; active: PanelId | null }
export type DockLeaf = Region | WorkLeaf;
export type DockNode = DockLeaf | Split<DockLeaf>;

/** Where one mode's panels sit around its working area; the application's, not a workspace's. */
export interface PanelLayout {
  root: DockNode;
  hidden: PanelId[];
  /** The region each hidden panel left, so it returns there. */
  lastRegion: Partial<Record<PanelId, string>>;
}
export type PanelLayouts = Record<DockedMode, PanelLayout>;

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
  upstream: string | null;
  ahead: number;
  behind: number;
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
  /** Which diff of `path` the tab shows. Set on every tab of the review area, never on an editor's. */
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
  /** A credential id. Null is unset, which a linked worktree takes from its
   *  repository; `""` is explicitly the user's own ssh setup. */
  sshKey: string | null;
  /** An identity id, three-state as `sshKey`. */
  identity: string | null;
  /** Whether this workspace's terminals carry its credentials; never inherited. */
  terminalCredentials: boolean;
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
  /** How the mode selector and every panel tab read: a word or a glyph, never both. */
  tabDisplay: "labels" | "icons";
  /** The mode a markdown file opens in. */
  markdownMode: "source" | "split" | "rich";
  /** The program a terminal tab runs; empty means `$SHELL`. */
  terminalShell: string;
  /** Which renderer a terminal draws with. */
  terminalGpu: "auto" | "webgl" | "dom";
  /** One dock tree per docked mode; null, or a mode left out, is that mode's default. */
  panelLayout: Partial<PanelLayouts> | null;
  workspaces: Record<string, WorkspaceSettings>;
  /** Changed only through the credential commands; `updateSettings` keeps the backend's. */
  credentials: Credentials;
  /** The page the settings dialog opens on. */
  settingsTab: string;
}

/** Keys and identities a workspace can be assigned. No secret is in here. */
export interface Credentials {
  keys: SshKey[];
  identities: Identity[];
}

export interface SshKey {
  id: string;
  name: string;
  /** The private key file, absolute. */
  path: string;
  /** Null until known: an encrypted PEM key without its `.pub` shows it once its passphrase is checked. */
  fingerprint: string | null;
  /** The key needs a passphrase. */
  protected: boolean;
  /** Its passphrase is in the wallet. */
  saved: boolean;
}

/** Who a workspace's commits are by. */
export interface Identity {
  id: string;
  label: string;
  name: string;
  email: string;
}

/** Read when the Credentials page shows. */
export interface CredentialStatus {
  wallet: { available: boolean; name: string | null; message: string | null };
  keys: Record<string, { missing: boolean; problem: string | null; stored: boolean }>;
}

/** A private key file in `~/.ssh`, offered by *Add SSH key*. */
export interface KeyFile {
  path: string;
  name: string;
  fingerprint: string | null;
  /** Null when ssh-keygen could not tell. */
  protected: boolean | null;
  problem: string | null;
}

/** A question ssh asked, waiting on the user in the window `window` names. */
export interface CredentialPrompt {
  id: string;
  window: WindowRole;
  kind: "host" | "passphrase" | "secret" | "confirm";
  title: string;
  text: string;
  host: string | null;
  fingerprint: string | null;
  /** Who asked: a workspace's Source Control, a terminal of one, or an unknown process. */
  origin: string;
}

/** A shell started without the credentials its workspace now gives terminals. */
export interface StaleTerminal {
  id: string;
  label: string;
}

/** What a paste or a drop did: the new workspace-relative path, or, when the
 *  name is taken and the conflict was `ask`, nothing yet and `exists`. */
export interface Transfer {
  path: string | null;
  exists: boolean;
}

/** What a branch holds that no other branch does. */
export interface Unmerged {
  count: number;
  /** `<short hash> <subject>`, at most twenty. */
  commits: string[];
}

/** What a paste does when the name is taken: ask first, replace it, or keep both. */
export type Conflict = "ask" | "replace" | "keep";

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
  short: string;
  /** Parent hashes, first parent first; more than one is a merge. */
  parents: string[];
  /** The refs pointing at this commit. */
  refs: RefName[];
  subject: string;
  author: string;
  /** Relative, as git words it: "4 hours ago". */
  date: string;
  timestamp: number;
  /** Subject and body together, shown in the history's hover popup. */
  message: string;
}

/** A ref decorating a commit. `head` is the branch HEAD is on, or `HEAD` itself when detached. */
export interface RefName {
  name: string;
  kind: "head" | "local" | "remote" | "tag";
}

export interface Stash {
  /** N in `stash@{N}`; it shifts when a stash above goes. */
  index: number;
  /** The stash's commit, which apply and drop name it by. */
  hash: string;
  /** The stash's subject as git records it: "On master: dock drag preview". */
  message: string;
  /** Relative, as git words it. */
  date: string;
  timestamp: number;
}

export interface Tag {
  name: string;
  /** The short hash of the commit the tag points at. */
  hash: string;
  /** The tag's message when annotated, else the commit's subject. */
  subject: string;
  /** Relative, as git words it. */
  date: string;
  annotated: boolean;
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
