---
id: 010-react-frontend
title: 'ADR-010: React with TypeScript, and one session snapshot as the only state'
summary: Why the frontend is React 19 over Vite in TypeScript, why it holds no state
  store of its own, and how one backend-published session snapshot keeps two windows
  showing the same workspace.
related:
- 001-two-os-windows
- 008-tauri-v2-on-arch-kde
- 009-xterm-and-portable-pty
- standards-code
- 014-one-layout-tree
---

# ADR-010: React with TypeScript, and one session snapshot as the only state

## Context

`008-tauri-v2-on-arch-kde` puts presentation in a webview and leaves the
choice of framework open. Two windows render the same workspace, and every
tab, tree and switcher in both has to agree with the backend and with each
other.

Key forces:

- **Two windows, one state.** A workspace switch made in either window has to
  reach both, and a stale window is a defect the user sees.
- **The backend already owns the state** (`standards-code`). A frontend store
  that mirrors it is a second copy to keep consistent.
- **The heavy components are framework-agnostic.** xterm.js and CodeMirror
  own their own DOM and their own state, and are mounted into a container
  rather than rendered by a framework.
- **A precedent exists.** `local-transcribe` ships React 19 over Vite on this
  stack, on this machine.

## Decision

The frontend is **React 19 with TypeScript, built by Vite**. Both windows load
the same entry — the title row, the status bar, settings and the palettes —
select their role from the Tauri window label, and import only that role's
half: the Workspace window never loads xterm.js and the Terminal window never
loads CodeMirror (`018-mount-what-is-on-screen`).

There is **no frontend state store**. The backend publishes one `session`
snapshot — workspaces, their tabs, the active workspace — as a Tauri event
whenever it changes, and each window renders from the latest snapshot. A
window changes state by invoking a command, never by mutating a local copy.

Components that own their DOM — terminals and editors — live outside React's
tree in a module-level registry keyed by tab id, and a React component only
mounts the instance's element into place.

## Rationale

- React's rendering model matches "render the latest snapshot": a new snapshot
  is a new render, with no diffing logic in application code.
- One event carrying the whole snapshot is the simplest thing that keeps two
  windows agreeing; the snapshot is small, so its cost is not worth optimising
  away.
- Keeping xterm.js and CodeMirror instances outside React is what lets them
  survive re-renders and workspace switches without re-creation.
- Reusing the reference project's stack means its Vite and Tauri configuration
  and its known traps carry over.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **No framework, TypeScript over the DOM** | The smallest dependency set, and the workspace window's tree, tabs, groups and overlays are enough stateful views that hand-written reconciliation becomes the framework. |
| **Svelte or Solid** | Smaller runtime and finer-grained updates, for a UI whose expensive parts are outside the framework anyway; no precedent on this stack. |
| **A frontend state library** | Gives local, synchronous state, at the cost of a second copy of what the backend owns and a synchronisation problem across two windows. |
| **Per-field events instead of a snapshot** | Less data per event, and every window has to assemble state from a sequence it may have joined late. |

## Consequences

**Easier:**
- Both windows are the same program; a workspace switch is one command and one
  event.
- A reloaded window recovers by fetching the snapshot once.

**Harder:**
- Every state change round-trips through the backend, so a purely visual
  toggle still has to decide whether it is session state.
- Instances kept outside React have to be disposed explicitly when their tab
  closes.

## Constraints imposed

- **A command is invoked from one module.** The frontend's typed API layer is
  the only place `invoke` and `listen` appear.
- **The snapshot is the contract.** Its TypeScript type mirrors the backend's
  serialised struct field for field.
- **Presentation state that need not survive a switch stays local.** A hovered
  row or an open menu is component state, not session state. Presentation
  state that must survive a switch — a filter, a draft, a list already
  fetched, a scroll offset — is kept in `src/live.ts`
  (`018-mount-what-is-on-screen`), not in the session.
