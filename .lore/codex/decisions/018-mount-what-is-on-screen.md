---
id: 018-mount-what-is-on-screen
title: 'ADR-018: Only what is on screen is mounted, and a workspace out of sight is quiet'
summary: Why the Workspace window mounts only the workspace and mode on screen and
  rebuilds the rest from state kept outside React; why a workspace out of sight
  costs no watch on its tree, no working-tree read and no mounted view; why the backend
  publishes and refreshes only on real change; why terminals are the one view kept
  whole; and why each window loads only its own half of the bundle.
related:
- 017-modes
- 016-terminal-output-and-renderer
- 002-backend-owned-terminal-sessions
- 009-xterm-and-portable-pty
- 010-react-frontend
- 012-git-through-the-git-binary
- standards-code
binds:
- src/live.ts
- src/App.tsx
- src/components/WorkspaceWindow.tsx
- src/components/WorkspaceFacts.tsx
- src/components/EditorArea.tsx
- src/components/FileTree.tsx
- src/components/DiffView.tsx
- src/editors.ts
- src/editor/document.ts
- src/repo.ts
- src-tauri/src/watch.rs
- src-tauri/src/session.rs
- src-tauri/src/git.rs
- src-tauri/src/store.rs
- src-tauri/src/agent.rs
- src-tauri/src/pty.rs
rites:
- diagnose-app-footprint
---

# ADR-018: Only what is on screen is mounted, and a workspace out of sight is quiet

## Context

`017-modes` first kept every workspace shown once, and both of its modes,
mounted for the life of the process, hidden by CSS, so that a switch was a
paint. The owner runs eight workspaces, five of them git worktrees of two
repositories, with agents at work in their terminals, and found the
application heavy from the moment it opened. Switching workspaces is the
application's core action; what a switch does inside is free to change as
long as everything the reader left comes back as it was, and terminals stay
whole.

Measured on a release build against those eight workspaces, headless, on
2026-09-24:

- **Memory grew with every workspace visited.** The Workspace window's web
  process went from 104 MB PSS at launch to 186 MB after every workspace had
  been shown in both modes, holding 11 300 DOM nodes and eight CodeMirror
  views; the whole application reached 420 MB.
- **Every hidden view kept working.** One session publish re-rendered every
  mounted view and made every mounted file tree list its root again through
  `git check-ignore`. The prompt's `git status` in any terminal took and
  dropped `index.lock`, which refreshed the summary of every workspace in that
  repository family and published again. A file written every second and a
  `git status` every two seconds in two repositories drove 16.4 git processes
  a second and 12% of a core.
- **A kept view was not a free switch.** Showing a workspace already mounted
  settled in 70–105 ms, 30–59 ms of it `switch_workspace` running git on the
  GTK main thread. Building a workspace's view for the first time settled in
  55–308 ms on a debug build.
- **Each window paid for the other.** Both webviews loaded one 1.5 MB bundle.
  The Terminal window's web process held about 100 MB for 65 DOM nodes,
  against about 52 MB for a blank WebKit page.

## Decision

**Mounted while shown.** `WorkspaceWindow` renders one `WorkspaceView`, for
the active workspace, and that view renders one mode, keyed so that a switch
of either rebuilds it. Inside the mode on screen, a region and the work leaf
keep each panel they have shown mounted behind the one in front, where `Live`
tells it to idle.

**Kept outside React.** `src/live.ts` holds what a reader would notice
missing after a rebuild. `useKept` is a `useState` over a module map: the
setter writes through at once and redraws whichever view reads the key now,
so a fetch or a push that finishes after its panel was taken down reaches the
panel built in its place. `keep` writes without redrawing, for an offset a
view records as it scrolls; `peek` reads once at build; `useKeptScroll`
restores a scroller once its content is there. Keys name their owner —
`<workspace>:<what>` or `<workspace>:tab:<tab>:<what>` — and `retainKept`
drops those of a removed workspace or a closed tab. Every panel keeps what the
reader typed, started or fetched: listings, filters and the Explorer's
multi-selection, the commit message, branch lists and a remote operation's
output, search hits, loaded history, diff text, and every list's scroll,
the outline's per tab. A rebuilt view paints that at once; the tree, the
lists and the diffs then read again, and Search keeps its last hits until it
is run again. It plays no entrance for what it kept: only a branch opened
after the tree was built unfolds, and only the output box of an operation run
from the panel fades in.

**Documents stay built.** The document registry in `src/editors.ts` keeps
each open tab's `Doc` with its CodeMirror views, history and selection; a
rebuild re-attaches it. `Doc` keeps the last scroll snapshot each view took
while it had height, and a re-attached view takes it at its next measure with
a height — at once, or when a panel shown over the working area steps aside.
A group built for the first time in the process focuses its document, as does
a tab brought forward in a group already on screen; a group rebuilt with the
tab it had in front leaves focus where it is.

**A workspace out of sight is quiet.** `watch::sync` watches the active
workspace's root, expanded directories and tab directories, and the git
directory of every workspace. `session::activate` calls `watch::catch_up`,
which reports the root, the expanded directories, the tab directories and the
repository as changed, so a workspace coming back reads what moved while it
was away. The watcher drops `*.lock` paths inside a git directory, sends no
`dir-changed` for a directory inside one unless a tab of the active workspace
is open on a file there, and attributes a change under
`worktrees/<name>` to that worktree's workspace. `git::refresh_summary`
reports whether a summary changed — a workspace whose directory is gone loses
its summary, which counts — and `watch::emit` prunes and publishes only when
one did. After any change in a git directory `watch::emit` re-syncs the
watched set, and `Watcher::heal` watches again a reported directory that was
deleted and created anew, since deleting a directory ends its watch. `session::publish` sends nothing when the snapshot equals the
last one sent; `store::save` skips a write whose text matches the last one
while the file is still there. `src/repo.ts` tells only the readers of the
workspace it read, only when a read changed something, and a file change
re-reads only the status list, unless no repository is held or git refuses
the status, when it reads everything. A tree filter's file list is read again
at most once a second while files change.

**Terminals stay whole.** Each terminal's xterm instance lives in
`src/terminals.ts` for the life of its tab, attached to its stream, whatever
workspace is on screen. The terminal on screen receives output on a 5 ms
window and every other on a 250 ms one (`016-terminal-output-and-renderer`).
`agent::quiet_loop` reads the directory of the shell on screen on the 250 ms
tick after it prints, and publishes when it moved, so a link printed after a
`cd` resolves against the right directory; every other shell's directory
reaches the windows with the publish `setup`'s thread makes every 30 seconds.

**Each window loads its half.** `App` imports the role's body and its
status-bar facts dynamically and renders once they, the session and the
settings are all present. The Workspace window never loads xterm.js, and the
Terminal window never loads CodeMirror or the git panels.

**The switch leaves the main thread.** `switch_workspace` runs as an async
command. `activate` starts the workspace's shells before it names the
workspace active, so a window attaching to a terminal finds its shell.

## Rationale

- Rebuilding costs about what showing a kept view cost, because the backend
  switch and the re-reads dominate both; with kept state the rebuilt view
  paints its last content on the first frame. Measured after the change, a
  workspace switch settles in 15–40 ms, and under 200 ms for the largest tree.
- Memory no longer holds a mounted view per workspace. What a visited
  workspace leaves is its open documents and its kept state, which level off
  once every workspace has been shown: after every workspace has been shown in
  both modes the application holds 334–341 MB (420 before), the same after the
  first tour and after the third.
- A workspace out of sight has no tree watch, no working-tree read and no
  mounted view; only a change in its git directory refreshes its summary, and
  its terminals flush on the 250 ms window. Agent activity that writes files
  and runs `git status` in workspaces not on screen starts no git process and
  uses 0.1% of a core; in the workspace on screen it starts two a second, one
  tree listing and one status read per file written.
- The split cuts what each window parses: the Terminal window loads 669 KB of
  JavaScript and the Workspace window 1.0 MB, instead of 1.5 MB each. For the
  whole change, in alternating launches, the application
  starts on 1.05–1.08 s of CPU and 279–292 MB, against 1.20–1.26 s and
  297–303 MB.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Keep every view mounted once shown** | The first shape of `017-modes`. A switch paints, but memory grows with every workspace visited and every hidden view does work on every event. |
| **Keep the last few views mounted** | A warm set makes a return to a recent workspace a paint, which kept state already achieves at the same speed; the set costs memory and a second code path. |
| **Rebuild without kept state** | Loses typed text, fetched lists, scroll and operations in flight, which a reader would notice on every switch. |
| **One web process for both windows** | Saves one WebKit process, and puts terminal keystrokes on the same main thread as a heavy diff or markdown render, undoing `016-terminal-output-and-renderer`; one crash blanks every scrollback. |
| **Detach terminals out of sight and replay on return** | Saves parsing hidden output, but an agent fills the 2 MiB replay tail in about a hundred seconds, so a return would lose scrollback. |
| **`React.lazy` for each window's half** | React 19 holds a Suspense boundary's content until 300 ms after its fallback was shown, so every window would open 300 ms later. |
| **WebKit CPU rendering or the document-viewer cache model** | Measured: neither changed memory or CPU on this machine. |

## Consequences

**Easier:**
- Mounted views and per-event work are bounded by one workspace and one mode,
  whatever the number of workspaces; open documents and kept state grow with
  the tabs and workspaces visited.
- A new panel gets preservation by reading its state through `useKept` and
  its scroller through `useKeptScroll`.

**Harder:**
- Every piece of view state has to be classified: kept, re-derived from the
  session or the registries, or dropped on purpose. A plain `useState` in a
  panel is lost at the next switch.
- A panel that starts an operation writes its outcome through `useKept`,
  never into a state only the starting view holds.
- A change in a workspace out of sight is seen when the workspace comes back,
  through `catch_up`, not when it happens; open documents of that workspace
  check their files then.

## Constraints imposed

- **A view out of sight is unmounted.** Nothing but a region's or the work
  leaf's panels behind the one in front, and a group's body behind a panel
  shown over it, stays mounted out of sight, and those idle through `Live`.
- **Terminals are never torn down by a switch.** An xterm instance ends only
  with its tab.
- **Shared code imports neither half.** `App`, `Switcher`, `StatusBar`,
  `SettingsDialog`, `CredentialsPage`, `CredentialPrompt`, `Palette`, `Menu`,
  `api`, `settings`, `modes`, `modal` and `notice` reach `editors`,
  `editor/*`, `repo` or `terminals` only by dynamic import; one static import
  merges the halves again without any warning. `modal` is imported by both
  halves, `terminals` and `editors` included, and imports nothing but React.
