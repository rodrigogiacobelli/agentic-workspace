// The one module that talks to the backend: every command and every event.

import { Channel, invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { DirChanged, Entry, Session, WindowRole } from "./types";

export type OutputChunk = ArrayBuffer | Uint8Array | number[];

export const api = {
  getSession: () => invoke<Session>("get_session"),
  takeNotices: () => invoke<string[]>("take_notices"),
  addWorkspace: (path: string) => invoke<string>("add_workspace", { path }),
  switchWorkspace: (id: string) => invoke<void>("switch_workspace", { id }),
  removeWorkspace: (id: string) => invoke<void>("remove_workspace", { id }),
  setExpanded: (workspaceId: string, path: string, expanded: boolean) =>
    invoke<void>("set_expanded", { workspaceId, path, expanded }),
  openFile: (workspaceId: string, path: string) =>
    invoke<string>("open_file", { workspaceId, path }),
  closeFile: (workspaceId: string, id: string) =>
    invoke<void>("close_file", { workspaceId, id }),
  setActiveEditor: (workspaceId: string, id: string) =>
    invoke<void>("set_active_editor", { workspaceId, id }),
  reorderEditors: (workspaceId: string, ids: string[]) =>
    invoke<void>("reorder_editors", { workspaceId, ids }),
  focusWindow: (label: WindowRole) => invoke<void>("focus_window", { label }),
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
  readFile: (workspaceId: string, path: string) =>
    invoke<string>("read_file", { workspaceId, path }),
  writeFile: (workspaceId: string, path: string, content: string) =>
    invoke<void>("write_file", { workspaceId, path, content }),

  copyText: (text: string) => writeText(text),
  pasteText: () => readText(),
  /** Asks the workspace window, which knows about unsaved buffers, to quit. */
  requestQuit: () => emitTo("workspace", "quit-requested"),
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
};

export function toBytes(chunk: OutputChunk): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return Uint8Array.from(chunk);
}
