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
  editors: EditorTab[];
  activeEditor: string | null;
  /** Expanded tree directories, relative to `path`. */
  expanded: string[];
  /** Recently opened files, relative to `path`, most recent first. */
  recentFiles: string[];
  available: boolean;
}

export interface TerminalTab {
  id: string;
  name: string | null;
  cwd: string;
}

export interface EditorTab {
  id: string;
  path: string;
  /** `source`, `split` or `rich`; meaningful for markdown only. */
  mode: string;
  /** First visible line, restored on reopen. */
  line: number;
}

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
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
  languages: Record<string, string>;
  workspaces: Record<string, WorkspaceSettings>;
}

export interface StoredAsset {
  path: string;
  link: string;
  bytes: number;
}
