// The modes: what the reader is doing in the application. Each owns its
// panels, its working area and its dock tree, and a tab exists inside one of
// them. Terminal is a mode that lives in a window of its own: picking it raises
// that window, and picking another mode from there raises the Workspace window
// back.

import { api } from "./api";
import type { IconName } from "./components/icons";
import type { DockedMode, ModeId, WindowRole, Workspace } from "./types";

export interface ModeInfo {
  id: ModeId;
  label: string;
  icon: IconName;
  /** The window the mode is drawn in. */
  window: WindowRole;
  hotkey: string;
}

export const MODES: ModeInfo[] = [
  { id: "editor", label: "Editor", icon: "text", window: "workspace", hotkey: "Ctrl+1" },
  { id: "scm", label: "Source Control", icon: "git", window: "workspace", hotkey: "Ctrl+2" },
  { id: "terminal", label: "Terminal", icon: "terminal", window: "terminal", hotkey: "Ctrl+3" },
];

/** The mode a window is showing for a workspace. */
export function modeOf(ws: Workspace | undefined, role: WindowRole): ModeId {
  return role === "terminal" ? "terminal" : ws?.mode ?? "editor";
}

/**
 * Picks a mode from the window `role`. A docked mode becomes the workspace's
 * mode, and a mode drawn in the other window raises that window.
 */
export async function pick(ws: Workspace | undefined, mode: ModeId, role: WindowRole): Promise<void> {
  const target = MODES.find((m) => m.id === mode);
  if (!target) return;
  if (ws && mode !== "terminal" && ws.mode !== mode) await api.setMode(ws.id, mode as DockedMode);
  if (target.window !== role) await api.focusWindow(target.window);
}
