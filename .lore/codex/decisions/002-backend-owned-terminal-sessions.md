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
  - 019-credentials-through-the-secret-service
  - 020-workspace-family
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

The Rust backend owns every PTY. A terminal session is keyed by its tab
(`AppState.ptys`), outlives the view that draws it, and ends when the
application exits. The tab sits in its workspace family's one list, which the
family's root holds (`020-workspace-family`); a tab moved from one list to
another keeps its shell running.

Restored state is the tab's **name and working directory** only. A restored tab
opens a fresh shell in that directory, or, when the directory is gone, in the
fallback `020-workspace-family` names (TERM-26). No output is replayed and no
command is re-run.

A shell starts in the user's environment, not the application's.
`pty::spawn` runs `desktop::clean_child_env` on it, which removes the
variables an AppImage exports and the WebKit variable the application set
itself (`standards-linux-desktop`). It adds the credentials of its family's
root only when the root's own terminal option is on (CRED-14,
`019-credentials-through-the-secret-service`), and `Live.credentials` records
the workspace whose credentials the shell started with, or none. *Restart
shell*, in a terminal tab's context menu and on the root's Workspace settings
page, asks first and then calls `terminal_restart`, which replaces a running
shell in place: the same tab, id, name and working directory — read from
`/proc/<pid>/cwd` — with a fresh shell in the family root's environment as it
is now. The new shell starts before the old one is hung up, and the exit of
the old one leaves the tab alone. A shell that has exited is not restarted;
its tab closes with it.

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
- A switch between families changes which terminal list is on screen, and a
  switch within one changes nothing there; no process is signalled.
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
  session, apart from a shell the user restarts or closes.
- **A shell's environment is the user's.** It goes through
  `clean_child_env`, and carries its family root's credentials only on the
  root's consent.
