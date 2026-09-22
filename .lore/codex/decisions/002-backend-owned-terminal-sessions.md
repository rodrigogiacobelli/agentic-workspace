---
id: 002-backend-owned-terminal-sessions
title: "ADR-002: Terminal sessions live in the backend and end with the app"
summary: Why PTYs are owned by the Rust backend rather than by a window or a
  webview, why sessions deliberately do not survive a restart, and what a
  restored tab contains instead — its working directory and a fresh shell.
related:
  - vision-agentic-workspace
  - 001-two-os-windows
  - 007-workspace-is-one-directory
---

# ADR-002: Terminal sessions live in the backend and end with the app

## Context

The product exists so that a background project's terminals keep running. That
requires deciding what owns a terminal session, and how long it lives.

Key forces:

- **Switching workspace must not disturb a running process.** An agent
  mid-edit and a dev server mid-request both have to survive being moved out of
  sight.
- **A webview cannot hold a process.** The terminal is drawn in a webview;
  anything owned by that view dies when it is unmounted or reloaded.
- **Session resurrection across a reboot is not achievable.** A process cannot
  be restarted into its prior state, and replaying yesterday's output next to a
  fresh prompt invites acting on stale information.

## Decision

The Rust backend owns every PTY. A terminal session is keyed by workspace and
tab, outlives the view that draws it, and ends when the application exits.

Restored state is the tab's **name and working directory** only. A restored tab
opens a fresh shell in that directory. No output is replayed and no command is
re-run.

## Rationale

- Detaching a view from a live PTY is the mechanism the whole product rests on;
  putting ownership in the backend is what makes it possible at all.
- A frontend that can be unmounted, reloaded or crashed without killing a
  process makes the UI layer replaceable and failures recoverable.
- The working directory is the part of a session that is genuinely worth
  restoring: it is what takes effort to rebuild, and it is unambiguous.
- Replayed scrollback next to a live prompt reads as current. A directory and
  a clean prompt cannot mislead.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Sessions owned by the terminal view** | No extra machinery, but a workspace switch would have to keep every view mounted, and a webview reload would kill every running agent. |
| **Persist scrollback across a restart** | Shows what the agent said before shutdown, but puts dead output above a live prompt where it reads as current state. |
| **Re-run the last command on restore** | Saves typing, but re-running a build, a migration or an agent unattended at launch is a side effect nobody asked for. |
| **Delegate persistence to `tmux`** | Real session survival across a restart, but it makes a terminal multiplexer a hard dependency and puts session state outside the application's control. |

## Consequences

**Easier:**
- A workspace switch detaches a view and attaches another; no process is
  signalled.
- The frontend can be reloaded, and a rendering crash costs no running work.

**Harder:**
- Output produced while a session is detached must be buffered, bounded and
  replayed in order on reattach.
- A detached session has no viewport, so terminal dimensions have to be
  reconciled on reattach and `SIGWINCH` delivered.
- Every PTY must be reaped on exit by any route, or the application leaks
  orphaned shells.

## Constraints imposed

- **A tab's working directory is read from `/proc/<pid>/cwd`.** Tracking it
  requires no shell integration, no prompt hook and no cooperation from the
  program running in the tab.
- **Scrollback is memory-only and bounded.** It is never written to disk.
- **Closing the Terminal window stops nothing.** Only application exit ends a
  session.
