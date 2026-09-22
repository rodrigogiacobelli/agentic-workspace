---
id: 001-two-os-windows
title: 'ADR-001: Two OS windows rather than one split window'
summary: Why Agentic Workspace ships a separate Workspace window and Terminal window
  instead of one window with a terminal pane, what the compositor gains from that,
  and the window-placement limits under Wayland it accepts in exchange.
related:
- vision-agentic-workspace
- 008-tauri-v2-on-arch-kde
- standards-linux-desktop
- 013-app-drawn-chrome-and-tray
---

# ADR-001: Two OS windows rather than one split window

## Context

The product has two surfaces with different shapes. Documents want a wide,
tall, stable area. Terminals want to be large while an agent is working and out
of the way when it is not, and there are usually several of them.

Key forces:

- **The two surfaces are watched at different times.** Reading a document and
  watching an agent work are separate activities that happen on different
  parts of the screen.
- **Multi-monitor and virtual-desktop arrangement is the compositor's job.** A
  window manager can place, tile and switch windows; it cannot do any of that
  to a pane inside one window.
- **Wayland gives a client no control over its own window position.** Under
  Wayland `set_position` succeeds and changes nothing, so any layout the
  application wants to impose across windows it cannot impose.

## Decision

Ship two top-level OS windows — `workspace` (file tree and editor) and
`terminal` — each with its own task-bar entry, each independently placeable by
the compositor. Both windows always display the same active workspace, and a
hotkey raises the other.

## Rationale

- Putting documents on one monitor and terminals on another is the arrangement
  the product is for, and it is expressible only as two windows.
- The compositor already solves placement, tiling, virtual desktops and
  window switching. A split pane reimplements a worse version of each.
- Closing the Terminal window is a natural way to hide terminals without
  stopping them, since `002-backend-owned-terminal-sessions` puts the sessions
  in the backend rather than in the window.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **One window, split panes** | Simplest to build and identical on every compositor, but the two surfaces can never sit on separate monitors, and every layout affordance — resize, zoom, hide — is a reimplementation of something KWin already does. |
| **One window, terminal as a drawer** | Fits a code-first editor where the terminal is occasional. Here the terminal is where the agent runs, so it is not the secondary surface. |
| **Tear-out: one window that can detach a pane** | Delivers both, but the detached state is the common case here, so the attached state would carry complexity that is rarely used. |

## Consequences

**Easier:**
- Documents and terminals can occupy separate monitors or virtual desktops.
- Either window can be closed without affecting the other or the processes
  running behind it.

**Harder:**
- Two windows must be kept showing the same workspace at all times; a single
  workspace switch has to drive both.
- Window geometry has to be restored per window, and position cannot be
  guaranteed under Wayland.
- The application must not exit when one window closes, and must reap every
  child process when it does exit.

## Constraints imposed

- **Neither window owns the session.** Workspace state, terminal sessions and
  settings live in the backend, so closing a window destroys no state.
- **A workspace switch is atomic across both windows.** There is no state in
  which the two windows show different workspaces.
- **Position is requested, never assumed.** Window size is restored; position
  is restored only where the session permits it, and the application reports no
  success it did not achieve.
