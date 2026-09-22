// The one module that talks to the backend: every command and every event.

import { Channel, invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  BlameLine, Branches, CommitDetail, DiffSpec, DirChanged, Entry, HotkeyStatus, ImportedTheme, LogEntry, RepoInfo, SearchHit,
  Session, Settings, StatusEntry, StoredAsset, WindowRole, WorktreeEntry,
} from "./types";

export type OutputChunk = ArrayBuffer | Uint8Array | number[];

export interface OpenAt {
  workspaceId: string;
  path: string;
  line: number;
  column: number;
}

export const api = {
  getSession: () => invoke<Session>("get_session"),
  takeNotices: () => invoke<string[]>("take_notices"),
  addWorkspace: (path: string, name?: string) => invoke<string>("add_workspace", { path, name: name ?? null }),
  switchWorkspace: (id: string) => invoke<void>("switch_workspace", { id }),
  removeWorkspace: (id: string) => invoke<void>("remove_workspace", { id }),
  renameWorkspace: (id: string, name: string) => invoke<void>("rename_workspace", { id, name }),
  setExpanded: (workspaceId: string, path: string, expanded: boolean) =>
    invoke<void>("set_expanded", { workspaceId, path, expanded }),
  openFile: (workspaceId: string, path: string) =>
    invoke<string>("open_file", { workspaceId, path }),
  openDiff: (workspaceId: string, path: string, diff: DiffSpec) =>
    invoke<string>("open_diff", { workspaceId, path, diff }),
  closeFile: (workspaceId: string, id: string) =>
    invoke<void>("close_file", { workspaceId, id }),
  setActiveEditor: (workspaceId: string, id: string) =>
    invoke<void>("set_active_editor", { workspaceId, id }),
  reorderEditors: (workspaceId: string, groupId: string, ids: string[]) =>
    invoke<void>("reorder_editors", { workspaceId, groupId, ids }),
  setActiveGroup: (workspaceId: string, groupId: string) =>
    invoke<void>("set_active_group", { workspaceId, groupId }),
  splitEditor: (workspaceId: string) => invoke<void>("split_editor", { workspaceId }),
  /** An empty `groupId` opens a new group to the right. */
  moveEditor: (workspaceId: string, id: string, groupId: string, index: number | null) =>
    invoke<void>("move_editor", { workspaceId, id, groupId, index }),
  setSplitRatio: (workspaceId: string, ratio: number) =>
    invoke<void>("set_split_ratio", { workspaceId, ratio }),
  setEditorView: (workspaceId: string, id: string, mode: string, line: number) =>
    invoke<void>("set_editor_view", { workspaceId, id, mode, line }),
  focusWindow: (label: WindowRole) => invoke<void>("focus_window", { label }),
  /** The title row's controls. Closing hides the window; the app stays in the tray. */
  windowMinimize: () => getCurrentWindow().minimize(),
  windowToggleMaximize: () => getCurrentWindow().toggleMaximize(),
  windowClose: () => getCurrentWindow().close(),
  windowMaximized: () => getCurrentWindow().isMaximized(),
  getSettings: () => invoke<Settings>("get_settings"),
  importThemes: (path: string) => invoke<ImportedTheme[]>("import_themes", { path }),
  listThemes: () => invoke<ImportedTheme[]>("list_themes"),
  deleteTheme: (id: string) => invoke<void>("delete_theme", { id }),
  hotkeyStatus: () => invoke<HotkeyStatus>("hotkey_status"),
  configureHotkey: () => invoke<void>("configure_hotkey"),
  saveDraft: (workspaceId: string, path: string, content: string) =>
    invoke<void>("save_draft", { workspaceId, path, content }),
  readDraft: (workspaceId: string, path: string) => invoke<string | null>("read_draft", { workspaceId, path }),
  deleteDraft: (workspaceId: string, path: string) => invoke<void>("delete_draft", { workspaceId, path }),
  updateSettings: (settings: Settings) => invoke<Settings>("update_settings", { settings }),
  /** Stores clipboard bytes; metadata travels as headers beside the raw body. */
  saveAsset: (workspaceId: string, note: string, name: string | null, mime: string, bytes: ArrayBuffer) =>
    invoke<StoredAsset>("save_asset", new Uint8Array(bytes), {
      headers: {
        "x-workspace": workspaceId,
        "x-note": encodeURIComponent(note),
        "x-mime": mime,
        ...(name ? { "x-name": encodeURIComponent(name) } : {}),
      },
    }),
  importAsset: (workspaceId: string, note: string, source: string) =>
    invoke<StoredAsset>("import_asset", { workspaceId, note, source }),
  openExternally: (workspaceId: string, path: string) =>
    invoke<void>("open_externally", { workspaceId, path }),
  quit: () => invoke<void>("quit"),

  terminalOpen: (workspaceId: string) => invoke<string>("terminal_open", { workspaceId }),
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),
  /** Installs `onOutput` for live bytes and returns the buffered tail. */
  terminalAttach: (id: string, cols: number, rows: number, onOutput: Channel<OutputChunk>) =>
    invoke<ArrayBuffer>("terminal_attach", { id, cols, rows, onOutput }),
  terminalDetach: (id: string) => invoke<void>("terminal_detach", { id }),
  terminalWrite: (id: string, data: string) => invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  terminalRename: (id: string, name: string | null) =>
    invoke<void>("terminal_rename", { id, name }),
  setActiveTerminal: (workspaceId: string, id: string) =>
    invoke<void>("set_active_terminal", { workspaceId, id }),
  reorderTerminals: (workspaceId: string, ids: string[]) =>
    invoke<void>("reorder_terminals", { workspaceId, ids }),

  listDir: (workspaceId: string, path: string) =>
    invoke<Entry[]>("list_dir", { workspaceId, path }),
  listFiles: (workspaceId: string) => invoke<string[]>("list_files", { workspaceId }),
  createEntry: (workspaceId: string, path: string, isDir: boolean) =>
    invoke<void>("create_entry", { workspaceId, path, isDir }),
  renameEntry: (workspaceId: string, from: string, to: string) =>
    invoke<void>("rename_entry", { workspaceId, from, to }),
  duplicateEntry: (workspaceId: string, path: string) =>
    invoke<string>("duplicate_entry", { workspaceId, path }),
  trashEntry: (workspaceId: string, path: string) =>
    invoke<void>("trash_entry", { workspaceId, path }),
  revealEntry: (workspaceId: string, path: string) =>
    invoke<void>("reveal_entry", { workspaceId, path }),
  searchProject: (workspaceId: string, query: string, includeIgnored: boolean) =>
    invoke<SearchHit[]>("search_project", { workspaceId, query, includeIgnored }),
  readFile: (workspaceId: string, path: string) =>
    invoke<string>("read_file", { workspaceId, path }),
  writeFile: (workspaceId: string, path: string, content: string) =>
    invoke<void>("write_file", { workspaceId, path, content }),

  gitInfo: (workspaceId: string) => invoke<RepoInfo>("git_info", { workspaceId }),
  gitInit: (workspaceId: string) => invoke<void>("git_init", { workspaceId }),
  gitStatus: (workspaceId: string) => invoke<StatusEntry[]>("git_status", { workspaceId }),
  gitDiff: (workspaceId: string, path: string, staged: boolean, untracked: boolean) =>
    invoke<string>("git_diff", { workspaceId, path, staged, untracked }),
  gitShowFile: (workspaceId: string, rev: string, path: string) =>
    invoke<string>("git_show_file", { workspaceId, rev, path }),
  gitCommitFileDiff: (workspaceId: string, hash: string, path: string) =>
    invoke<string>("git_commit_file_diff", { workspaceId, hash, path }),
  gitStage: (workspaceId: string, paths: string[]) => invoke<void>("git_stage", { workspaceId, paths }),
  gitUnstage: (workspaceId: string, paths: string[]) => invoke<void>("git_unstage", { workspaceId, paths }),
  gitStageAll: (workspaceId: string) => invoke<void>("git_stage_all", { workspaceId }),
  gitUnstageAll: (workspaceId: string) => invoke<void>("git_unstage_all", { workspaceId }),
  gitApplyHunk: (workspaceId: string, patch: string, reverse: boolean) =>
    invoke<void>("git_apply_hunk", { workspaceId, patch, reverse }),
  gitDiscard: (workspaceId: string, path: string, untracked: boolean) =>
    invoke<void>("git_discard", { workspaceId, path, untracked }),
  gitCommit: (workspaceId: string, message: string, amend: boolean) =>
    invoke<string>("git_commit", { workspaceId, message, amend }),
  gitLastMessage: (workspaceId: string) => invoke<string>("git_last_message", { workspaceId }),
  gitLog: (workspaceId: string, skip: number, limit: number, path: string | null) =>
    invoke<LogEntry[]>("git_log", { workspaceId, skip, limit, path }),
  gitShow: (workspaceId: string, hash: string) => invoke<CommitDetail>("git_show", { workspaceId, hash }),
  gitBlame: (workspaceId: string, path: string) => invoke<BlameLine[]>("git_blame", { workspaceId, path }),
  gitBranches: (workspaceId: string) => invoke<Branches>("git_branches", { workspaceId }),
  gitCreateBranch: (workspaceId: string, name: string, start: string | null) =>
    invoke<void>("git_create_branch", { workspaceId, name, start }),
  gitCheckout: (workspaceId: string, name: string, stash: boolean) =>
    invoke<string>("git_checkout", { workspaceId, name, stash }),
  gitDeleteBranch: (workspaceId: string, name: string, force: boolean) =>
    invoke<string>("git_delete_branch", { workspaceId, name, force }),
  gitUnmergedCommits: (workspaceId: string, name: string) =>
    invoke<string[]>("git_unmerged_commits", { workspaceId, name }),
  gitWorktrees: (workspaceId: string) => invoke<WorktreeEntry[]>("git_worktrees", { workspaceId }),
  gitAddWorktree: (workspaceId: string, path: string, branch: string, create: boolean) =>
    invoke<string>("git_add_worktree", { workspaceId, path, branch, create }),
  gitRemoveWorktree: (workspaceId: string, path: string, force: boolean) =>
    invoke<string>("git_remove_worktree", { workspaceId, path, force }),
  gitWorktreeDirty: (path: string) => invoke<string[]>("git_worktree_dirty", { path }),
  gitPruneWorktrees: (workspaceId: string, dryRun: boolean) =>
    invoke<string[]>("git_prune_worktrees", { workspaceId, dryRun }),
  gitRemote: (workspaceId: string, action: "fetch" | "pull" | "push", setUpstream: boolean) =>
    invoke<string>("git_remote", { workspaceId, action, setUpstream }),

  copyText: (text: string) => writeText(text),
  pasteText: () => readText(),
  /** Asks the workspace window, which knows about unsaved buffers, to quit. */
  requestQuit: () => emitTo("workspace", "quit-requested"),
  /** Asks the workspace window to open a file at a line, from a terminal link. */
  openAt: (target: OpenAt) => emitTo("workspace", "open-at", target),
};

export const events = {
  onSession: (cb: (s: Session) => void): Promise<UnlistenFn> =>
    listen<Session>("session-changed", (e) => cb(e.payload)),
  onNotice: (cb: (message: string) => void): Promise<UnlistenFn> =>
    listen<string>("notice", (e) => cb(e.payload)),
  onDirChanged: (cb: (p: DirChanged) => void): Promise<UnlistenFn> =>
    listen<DirChanged>("dir-changed", (e) => cb(e.payload)),
  onQuitRequested: (cb: () => void): Promise<UnlistenFn> =>
    listen("quit-requested", () => cb()),
  onSettings: (cb: (s: Settings) => void): Promise<UnlistenFn> =>
    listen<Settings>("settings-changed", (e) => cb(e.payload)),
  onGitChanged: (cb: (workspaceId: string) => void): Promise<UnlistenFn> =>
    listen<string>("git-changed", (e) => cb(e.payload)),
  onHotkey: (cb: (s: HotkeyStatus) => void): Promise<UnlistenFn> =>
    listen<HotkeyStatus>("hotkey-changed", (e) => cb(e.payload)),
  onOpenAt: (cb: (t: OpenAt) => void): Promise<UnlistenFn> =>
    listen<OpenAt>("open-at", (e) => cb(e.payload)),
  onWindowResized: (cb: () => void): Promise<UnlistenFn> => getCurrentWindow().onResized(() => cb()),
};

export function toBytes(chunk: OutputChunk): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return Uint8Array.from(chunk);
}
