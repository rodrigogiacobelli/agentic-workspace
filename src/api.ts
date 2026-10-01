// The one module that talks to the backend: every command and every event.

import { Channel, invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  AreaId, BlameLine, Branches, ClipboardFiles, CommitDetail, Conflict, CredentialPrompt, CredentialStatus, DiffSpec, DirChanged, DockedMode,
  Entry, HotkeyStatus, ImportedTheme, KeyFile, LogEntry, RepoInfo, SearchHit, Session, Settings, StaleTerminal, Stash, StatusEntry,
  StoredAsset, Tag, Transfer, Unmerged, WindowRole, WorktreeEntry,
} from "./types";

/** Terminal output arrives base64-encoded (see `pty::MAX_MESSAGE_BYTES`); the
 * other shapes are what tauri's channel hands back for a raw body. */
export type OutputChunk = string | ArrayBuffer | Uint8Array | number[];

/** An edge or corner of the window, as the window API names them. */
export type ResizeDirection = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

export interface OpenAt {
  workspaceId: string;
  path: string;
  line: number;
  column: number;
}

export const api = {
  getSession: () => invoke<Session>("get_session"),
  takeNotices: () => invoke<string[]>("take_notices"),
  /** What launch moved aside as unreadable, once; only the Workspace window asks (NTF-04). */
  takeSetAside: () => invoke<string[]>("take_set_aside"),
  /** Opens a folder, or switches to the workspace already on it. A linked
   *  worktree goes under `openedUnder` when that is a row on its repository. */
  addWorkspace: (path: string, name?: string, fromWorktree = false, openedUnder?: string) =>
    invoke<string>("add_workspace", { path, name: name ?? null, fromWorktree, openedUnder: openedUnder ?? null }),
  switchWorkspace: (id: string) => invoke<void>("switch_workspace", { id }),
  removeWorkspace: (id: string) => invoke<void>("remove_workspace", { id }),
  renameWorkspace: (id: string, name: string) => invoke<void>("rename_workspace", { id, name }),
  /** Every workspace id, in the order the switcher and the tray list them. */
  reorderWorkspaces: (ids: string[]) => invoke<void>("reorder_workspaces", { ids }),
  /** Which mode the Workspace window shows for a workspace. */
  setMode: (workspaceId: string, mode: DockedMode) => invoke<void>("set_mode", { workspaceId, mode }),
  /** Opens or folds each folder named, in one session change: in the Explorer, or in the view `view` (TREE-20). */
  setExpanded: (workspaceId: string, paths: string[], expanded: boolean, view: string | null = null) =>
    invoke<void>("set_expanded", { workspaceId, view, paths, expanded }),
  /** A preview open reuses the group's preview tab; a permanent one keeps its own. */
  openFile: (workspaceId: string, path: string, preview: boolean) =>
    invoke<string>("open_file", { workspaceId, path, preview }),
  /** Opens a diff in Source Control's working area, never the Editor's. */
  openDiff: (workspaceId: string, path: string, diff: DiffSpec) =>
    invoke<string>("open_diff", { workspaceId, path, diff }),
  pinEditor: (workspaceId: string, id: string) => invoke<void>("pin_editor", { workspaceId, id }),
  closeFile: (workspaceId: string, id: string) =>
    invoke<void>("close_file", { workspaceId, id }),
  setActiveEditor: (workspaceId: string, id: string) =>
    invoke<void>("set_active_editor", { workspaceId, id }),
  reorderEditors: (workspaceId: string, groupId: string, ids: string[], moved: string | null) =>
    invoke<void>("reorder_editors", { workspaceId, groupId, ids, moved }),
  setActiveGroup: (workspaceId: string, groupId: string) =>
    invoke<void>("set_active_group", { workspaceId, groupId }),
  splitEditor: (workspaceId: string, area: AreaId = "editor") => invoke<void>("split_editor", { workspaceId, area }),
  /** An empty `groupId` opens a new group to the right of the active one. */
  moveEditor: (workspaceId: string, id: string, groupId: string, index: number | null) =>
    invoke<void>("move_editor", { workspaceId, id, groupId, index }),
  /** A tab or a file dropped on a group's centre or one of its edges. */
  dropEditor: (workspaceId: string, source: { editor?: string; path?: string }, target: string, zone: string, index: number | null) =>
    invoke<void>("drop_editor", { workspaceId, source, target, zone, index }),
  setLayoutSizes: (workspaceId: string, area: AreaId, path: number[], sizes: number[]) =>
    invoke<void>("set_layout_sizes", { workspaceId, area, path, sizes }),
  setEditorView: (workspaceId: string, id: string, mode: string, line: number) =>
    invoke<void>("set_editor_view", { workspaceId, id, mode, line }),
  focusWindow: (label: WindowRole) => invoke<void>("focus_window", { label }),
  /** The title row's controls. Closing hides the window; the app stays in the tray. */
  windowMinimize: () => getCurrentWindow().minimize(),
  windowToggleMaximize: () => getCurrentWindow().toggleMaximize(),
  windowClose: () => getCurrentWindow().close(),
  windowMaximized: () => getCurrentWindow().isMaximized(),
  /** Hands a resize from the window's edge to the compositor (CHR-05). */
  windowStartResize: (direction: ResizeDirection) => getCurrentWindow().startResizeDragging(direction),
  /** The compositor's window menu, at a point in this window. */
  showWindowMenu: (x: number, y: number) => invoke<void>("show_window_menu", { x, y }),
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

  credentialsStatus: () => invoke<CredentialStatus>("credentials_status"),
  /** The private keys in `~/.ssh` that could be added. */
  credentialsKeyFiles: () => invoke<KeyFile[]>("credentials_key_files"),
  /** Returns the new credential's id. */
  credentialAddKey: (path: string) => invoke<string>("credential_add_key", { path }),
  credentialRenameKey: (id: string, name: string) => invoke<void>("credential_rename_key", { id, name }),
  /** Checks the passphrase against the key, then stores it in the wallet. */
  credentialSavePassphrase: (id: string, passphrase: string) =>
    invoke<void>("credential_save_passphrase", { id, passphrase }),
  /** Deletes its wallet entry first, then the credential and every assignment to it. */
  credentialRemoveKey: (id: string) => invoke<void>("credential_remove_key", { id }),
  /** Returns the new identity's id. */
  credentialAddIdentity: (label: string, name: string, email: string) =>
    invoke<string>("credential_add_identity", { label, name, email }),
  credentialUpdateIdentity: (id: string, label: string, name: string, email: string) =>
    invoke<void>("credential_update_identity", { id, label, name, email }),
  credentialRemoveIdentity: (id: string) => invoke<void>("credential_remove_identity", { id }),
  /** Null unsets a field; `""` is explicitly the user's own setup. */
  setWorkspaceCredentials: (workspaceId: string, sshKey: string | null, identity: string | null, terminals: boolean) =>
    invoke<void>("set_workspace_credentials", { workspaceId, sshKey, identity, terminals }),
  /** The prompts from ssh still waiting on an answer. */
  credentialPrompts: () => invoke<CredentialPrompt[]>("credential_prompts"),
  /** Null declines. */
  credentialPromptAnswer: (id: string, answer: string | null) =>
    invoke<void>("credential_prompt_answer", { id, answer }),
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

  /** `cwd` is workspace-relative; null starts in the workspace's root. */
  terminalOpen: (workspaceId: string, cwd: string | null = null) => invoke<string>("terminal_open", { workspaceId, cwd }),
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),
  /** Starts the shell again in the same tab, from the same directory, with a fresh environment. */
  terminalRestart: (id: string) => invoke<void>("terminal_restart", { id }),
  /** The workspace's shells that started without the credentials its terminals now carry. */
  workspaceStaleTerminals: (workspaceId: string) =>
    invoke<StaleTerminal[]>("workspace_stale_terminals", { workspaceId }),
  /** Installs `onOutput` for live bytes and returns the buffered tail. */
  terminalAttach: (id: string, cols: number, rows: number, onOutput: Channel<OutputChunk>) =>
    invoke<ArrayBuffer>("terminal_attach", { id, cols, rows, onOutput }),
  terminalDetach: (id: string) => invoke<void>("terminal_detach", { id }),
  terminalAck: (id: string, chars: number) => invoke<void>("terminal_ack", { id, chars }),
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
  /** Name, kind, ignored and missing state for each workspace-relative path. */
  statEntries: (workspaceId: string, paths: string[]) => invoke<Entry[]>("stat_entries", { workspaceId, paths }),
  viewCreate: (workspaceId: string, name: string) => invoke<string>("view_create", { workspaceId, name }),
  viewRename: (workspaceId: string, viewId: string, name: string) => invoke<void>("view_rename", { workspaceId, viewId, name }),
  viewDelete: (workspaceId: string, viewId: string) => invoke<void>("view_delete", { workspaceId, viewId }),
  viewAdd: (workspaceId: string, viewId: string, paths: string[]) => invoke<void>("view_add", { workspaceId, viewId, paths }),
  viewRemove: (workspaceId: string, viewId: string, paths: string[]) => invoke<void>("view_remove", { workspaceId, viewId, paths }),
  viewReorder: (workspaceId: string, viewId: string, paths: string[]) => invoke<void>("view_reorder", { workspaceId, viewId, paths }),
  setActiveView: (workspaceId: string, viewId: string | null) => invoke<void>("set_active_view", { workspaceId, viewId }),
  createEntry: (workspaceId: string, path: string, isDir: boolean) =>
    invoke<void>("create_entry", { workspaceId, path, isDir }),
  renameEntry: (workspaceId: string, from: string, to: string) =>
    invoke<void>("rename_entry", { workspaceId, from, to }),
  duplicateEntry: (workspaceId: string, path: string) =>
    invoke<string>("duplicate_entry", { workspaceId, path }),
  /** Moves each path to the desktop's trash; answers the failures, one `<path>: <reason>` each. */
  trashEntries: (workspaceId: string, paths: string[]) =>
    invoke<string[]>("trash_entries", { workspaceId, paths }),
  /** Copies, or moves when `cut`, an absolute path into a workspace directory.
   *  Under `ask` a taken name comes back as `exists`, with nothing done; under
   *  null a copy takes a free name and a move onto a taken one fails. */
  pasteEntry: (workspaceId: string, from: string, toDir: string, cut: boolean, conflict: Conflict | null = null) =>
    invoke<Transfer>("paste_entry", { workspaceId, from, toDir, cut, conflict }),
  /** The desktop clipboard's file list, empty when it holds anything else. */
  clipboardFiles: () => invoke<ClipboardFiles>("clipboard_files"),
  setClipboardFiles: (paths: string[], cut: boolean) =>
    invoke<void>("set_clipboard_files", { paths, cut }),
  clearClipboardFiles: () => invoke<void>("clear_clipboard_files"),
  revealEntry: (workspaceId: string, path: string) =>
    invoke<void>("reveal_entry", { workspaceId, path }),
  /** Whether Ctrl was held at the last drop: WebKitGTK's own `ctrlKey` in a drag is stale. */
  dropModifiers: (native: boolean) => invoke<{ ctrl: boolean }>("drop_modifiers", { native }),
  searchProject: (workspaceId: string, query: string, includeIgnored: boolean) =>
    invoke<SearchHit[]>("search_project", { workspaceId, query, includeIgnored }),
  readFile: (workspaceId: string, path: string) =>
    invoke<string>("read_file", { workspaceId, path }),
  /** Which version of the file is on disk, or null when none is (IMG-09). */
  fileStamp: (workspaceId: string, path: string) =>
    invoke<string | null>("file_stamp", { workspaceId, path }),
  writeFile: (workspaceId: string, path: string, content: string) =>
    invoke<void>("write_file", { workspaceId, path, content }),

  gitInfo: (workspaceId: string) => invoke<RepoInfo>("git_info", { workspaceId }),
  gitInit: (workspaceId: string) => invoke<void>("git_init", { workspaceId }),
  gitStatus: (workspaceId: string) => invoke<StatusEntry[]>("git_status", { workspaceId }),
  gitDiff: (workspaceId: string, path: string, staged: boolean, untracked: boolean) =>
    invoke<string>("git_diff", { workspaceId, path, staged, untracked }),
  /** Null when git cannot read the file at that revision, or the file is binary. */
  gitShowFile: (workspaceId: string, rev: string, path: string) =>
    invoke<string | null>("git_show_file", { workspaceId, rev, path }),
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
  /** In date order, so a commit always comes before its parents; `all` walks every branch, remote and tag, not only HEAD. */
  gitLog: (workspaceId: string, skip: number, limit: number, path: string | null, all: boolean) =>
    invoke<LogEntry[]>("git_log", { workspaceId, skip, limit, path, all }),
  gitShow: (workspaceId: string, hash: string) => invoke<CommitDetail>("git_show", { workspaceId, hash }),
  gitBlame: (workspaceId: string, path: string) => invoke<BlameLine[]>("git_blame", { workspaceId, path }),
  gitBranches: (workspaceId: string) => invoke<Branches>("git_branches", { workspaceId }),
  gitCreateBranch: (workspaceId: string, name: string, start: string | null) =>
    invoke<void>("git_create_branch", { workspaceId, name, start }),
  gitCheckout: (workspaceId: string, name: string, stash: boolean) =>
    invoke<string>("git_checkout", { workspaceId, name, stash }),
  gitDeleteBranch: (workspaceId: string, name: string, force: boolean) =>
    invoke<string>("git_delete_branch", { workspaceId, name, force }),
  /** The commits no other branch or remote holds. */
  gitUnmergedCommits: (workspaceId: string, name: string) =>
    invoke<Unmerged>("git_unmerged_commits", { workspaceId, name }),
  gitWorktrees: (workspaceId: string) => invoke<WorktreeEntry[]>("git_worktrees", { workspaceId }),
  gitAddWorktree: (workspaceId: string, path: string, branch: string, create: boolean) =>
    invoke<string>("git_add_worktree", { workspaceId, path, branch, create }),
  gitRemoveWorktree: (workspaceId: string, path: string, force: boolean) =>
    invoke<string>("git_remove_worktree", { workspaceId, path, force }),
  gitWorktreeDirty: (path: string) => invoke<string[]>("git_worktree_dirty", { path }),
  gitPruneWorktrees: (workspaceId: string, dryRun: boolean) =>
    invoke<string[]>("git_prune_worktrees", { workspaceId, dryRun }),
  /** Git's whole output on success; on failure the rejection carries git's whole message. */
  gitRemote: (workspaceId: string, action: "fetch" | "pull" | "push", setUpstream: boolean) =>
    invoke<string>("git_remote", { workspaceId, action, setUpstream }),
  gitStashes: (workspaceId: string) => invoke<Stash[]>("git_stashes", { workspaceId }),
  /** Stashes every change, untracked files included. */
  gitStashPush: (workspaceId: string, message: string | null) => invoke<string>("git_stash_push", { workspaceId, message }),
  /** Applies the stash with commit `hash`, wherever it sits now; `pop` drops it once applied. */
  gitStashApply: (workspaceId: string, hash: string, pop: boolean) => invoke<string>("git_stash_apply", { workspaceId, hash, pop }),
  gitStashDrop: (workspaceId: string, hash: string) => invoke<string>("git_stash_drop", { workspaceId, hash }),
  /** Newest first. */
  gitTags: (workspaceId: string) => invoke<Tag[]>("git_tags", { workspaceId }),
  /** An annotated tag when `message` is given, a lightweight one otherwise; `target` defaults to HEAD. */
  gitCreateTag: (workspaceId: string, name: string, message: string | null, target: string | null) =>
    invoke<void>("git_create_tag", { workspaceId, name, message, target }),
  gitDeleteTag: (workspaceId: string, name: string) => invoke<string>("git_delete_tag", { workspaceId, name }),

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
  onInfo: (cb: (message: string) => void): Promise<UnlistenFn> =>
    listen<string>("notice-info", (e) => cb(e.payload)),
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
  onCredentialPrompt: (cb: (p: CredentialPrompt) => void): Promise<UnlistenFn> =>
    listen<CredentialPrompt>("credential-prompt", (e) => cb(e.payload)),
  /** A prompt that stopped waiting; the id is the prompt's. */
  onCredentialPromptClosed: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("credential-prompt-closed", (e) => cb(e.payload)),
  /** A terminal's shell was restarted in place; the id is the tab's. */
  onTerminalRestarted: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("terminal-restarted", (e) => cb(e.payload)),
  onWindowResized: (cb: () => void): Promise<UnlistenFn> => getCurrentWindow().onResized(() => cb()),
};

export function toBytes(chunk: OutputChunk): Uint8Array {
  if (typeof chunk === "string") {
    const binary = atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return Uint8Array.from(chunk);
}
