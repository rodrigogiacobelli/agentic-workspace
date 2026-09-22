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
