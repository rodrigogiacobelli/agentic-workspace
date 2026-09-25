---
id: 017-modes
title: 'ADR-017: Modes own their panels, their working area and their dock tree'
summary: Why the Workspace window shows one of two modes — Editor or Source Control —
  with Terminal as a third mode drawn in its own window; why each mode owns its panels,
  its working area and its dock tree; why a diff is a tab of Source Control's working
  area and never of the Editor's; and why the status bar belongs to the application.
related:
- 001-two-os-windows
- 013-app-drawn-chrome-and-tray
- 014-one-layout-tree
- 012-git-through-the-git-binary
- 018-mount-what-is-on-screen
- standards-code
binds:
- src/modes.ts
- src/repo.ts
- src/components/dock.ts
- src/components/WorkspaceWindow.tsx
- src/components/Switcher.tsx
- src/components/StatusBar.tsx
- src/components/CommitPanel.tsx
- src/components/HistoryPanel.tsx
- src/components/BranchesPanel.tsx
- src/components/WorktreesPanel.tsx
- src/components/TagsPanel.tsx
- src-tauri/src/state.rs
- src-tauri/src/session.rs
---

# ADR-017: Modes own their panels, their working area and their dock tree

## Context

The Workspace window held one dock tree for the whole application: Files,
Search, Git and Outline around one editor area. A diff opened from the Git
panel became a tab among the editor's file tabs, so a commit could leave the
editor showing a diff in place of the document being written, and the Git
panel had to fit a status list, a commit box, a history and the branch and
worktree palettes into one sidebar column.

Key forces:

- **Two jobs, two surfaces.** Writing and reading documents is most of the
  work; reviewing and committing changes is a separate activity with its own
  lists — changes, history, branches, worktrees, tags — that crowd a column
  shared with a file tree.
- **A tab belongs to one job.** A diff among the files is the ambiguity that
  left the editor stuck on a diff after a commit.
- **Terminal already lives apart.** It has its own window
  (`001-two-os-windows`) and is a third thing the reader does.
- **Switching must cost nothing.** A reader moves between writing and
  reviewing several times an hour, and a rebuild of CodeMirror on each switch
  reads as reopening the application. The same holds for a workspace switch.
- **The branch is a fact about the workspace.** It has to stay visible while
  writing, since an agent may switch branches under the reader.

## Decision

**A mode is what the reader is doing.** `src/modes.ts` names three —
`editor`, `scm` (Source Control) and `terminal` — each with the window it is
drawn in. Editor and Source Control share the Workspace window; Terminal is
drawn in the Terminal window. The mode the Workspace window shows is a
property of the workspace: `Workspace.mode` in `src-tauri/src/state.rs`, set by
`session::set_mode` and saved with the session, so returning to a workspace
returns to what was being done in it.

**The selector.** `src/components/Switcher.tsx` draws the title row as the
logo, the workspace selector, the mode selector and the right-hand controls.
The mode selector sits at the middle of the window, not of the space the two
ends leave, and its three buttons share one width. `modes::pick` sets a docked
mode on the workspace, and raises the other window when the mode picked is
drawn there: Terminal from the Workspace window, Editor or Source Control from
the Terminal window. The Terminal button carries a dot while a shell runs in
the active workspace, lit when one printed out of view. `Ctrl+1`, `Ctrl+2` and
`Ctrl+3` pick the three modes in either window.

**Labels or icons.** `Settings.tabDisplay` is `labels` or `icons`, never both.
`settings::apply` writes it to `data-tabs` on the document root; every mode
button and panel tab draws a word and a glyph, and the stylesheet shows the
one chosen. A mode button is 132 px wide in labels and 40 px in icons. A panel
whose tab shows a glyph draws its name at its own head.

**Panels per mode.** `PANELS` in `src/components/dock.ts` gives each panel one
mode. The Editor holds Explorer, Custom, Search and Outline; Source Control
holds Commit, History, Branches, Worktrees and Tags. Commit lists conflicts,
staged, changed and untracked files and the stashes, with the commit box at
its foot (GIT-18). Branches carries fetch, pull and push, the local and remote
branches, and git's whole output of the last remote operation (GIT-17).
Explorer is the workspace's tree; Custom shows one of the workspace's views
(`015-views-and-citations`).

**One dock tree per mode.** `Settings.panelLayout` holds `{ editor, scm }`,
each a `PanelLayout` of the kind `014-one-layout-tree` describes, and each the
application's (DOCK-08). `defaultLayout(mode)` spreads the panels so no strip
holds more than three tabs: the Editor puts Explorer, Custom and Search left
and Outline right; Source Control puts Commit left, History right and
Branches, Worktrees and Tags under the working area. `normalizeAll` repairs
both trees on every read, and reads a single tree stored before modes as the
Editor's, with Files as Explorer and Custom and without Git.

**Two working areas.** A workspace holds the Editor's groups at its top level
(`groups`, `activeGroup`, `layout`) and Source Control's under `review`, each
an `Area` in `state.rs` with the same group tree. `session::open_file` opens in
the Editor's area and `session::open_diff` in Source Control's; every command
that names a tab or a group acts in the area holding it, and a move or drop
between the areas is refused. A tab of Source Control's area always carries a
`diff`; a tab of the Editor's never does. `Workspace::ensure_groups` moves a
diff tab found in the Editor's area into Source Control's.

**The working area takes panels.** The dock tree's work leaf holds panels of
its own: a panel dropped on its centre becomes a tab at the head of the
area's first group, in front of the files or diffs, and shown it takes that
group's body until a file or diff tab is picked, or a file or diff is opened —
from a panel, quick open, a link or a terminal — which comes to the front.

**One mode on screen.** The Workspace window mounts the active workspace in
its mode and nothing else; a switch of mode or workspace rebuilds the view,
which comes back as the reader left it (`018-mount-what-is-on-screen`). A
region, and the work leaf, keep each panel they have shown mounted behind the
one in front. `Live` in `src/live.ts` tells such a panel whether it is in
front, and `useChanged` re-reads a panel or a diff on a change only while it
is; one behind marks itself stale and re-reads once when it comes forward.

**One repository store.** `src/repo.ts` holds each workspace's `RepoInfo`,
status list and stashes. The workspace on screen re-reads 300 ms after the
first change the watcher reports, and that read takes every change reported
while it waits: the status list alone for a changed file, everything for a
change in the git directory. One in the background is marked stale and re-read
when shown. A read that brings back what is held tells nobody, and one that
changes something tells only that workspace's readers.
`git_remote` reports a fetch, pull or push itself, since the refs it moves are
not watched. Commit, the Explorer's decorations and the status bar read the
same copy.

**The application's status bar.** `src/components/StatusBar.tsx` sits below
the body in both windows. The mode on screen fills its left: the cursor, the
markdown mode, blame and the language in the Editor; the changed, staged,
conflict and stash counts in Source Control; the shell, its directory and the
tab count in Terminal. Each window's half supplies those facts —
`src/components/WorkspaceFacts.tsx` and `TerminalFacts` in
`src/components/TerminalWindow.tsx` — so the bar itself loads neither half. The workspace name and the branch with its ahead and
behind counts hold the right end, and the branch picks Source Control.

## Rationale

- A mode gives each activity its own furniture: Source Control's five panels
  spread over three regions instead of stacking in one column, and the
  Editor's working area holds only documents.
- Keeping the two working areas apart in the backend means a diff can never
  land among the files, whatever the frontend asks for.
- The mode belongs to the workspace because a review left in one project is
  still waiting when the reader comes back to it; panel placement stays the
  application's because it is furniture.
- A status bar outside every mode keeps the branch on screen while writing and
  in the Terminal window, where the branch matters as much.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **One dock tree shared by both modes** | One tree to store, and the regions sized for four editor panels are wrong for five git panels; a panel from one mode would sit in the other's layout. |
| **The branch in the title row** | The no-change answer, and it crowds the row that now carries the mode selector; the status bar holds it in both windows. |
| **Terminal as a pill outside the selector** | Marks the other window as different, and hides the model: Terminal is a mode that lives elsewhere, and the selector says so. |
| **Stashes and Remote as their own tabs** | Seven tabs fit no strip; a stash is made from the change list and a fetch's output belongs beside the branches it moved. |
| **The Source Control working area in the frontend** | Needs no backend change, and loses the session's persistence and duplicates every group command in TypeScript. |

## Consequences

**Easier:**
- A new mode is an entry in `MODES`, its panels in `PANELS`, a default tree
  and — if it has a working area — an `Area`.
- A diff and a document never compete for one tab strip.

**Harder:**
- A panel that reads data on a change has to go through `useChanged`, or it
  keeps working while behind another tab.
- Every command over tabs resolves an area first, and the ids of tabs and
  groups have to stay unique across both areas.
- A region is a size container (`container-type: inline-size`), which makes it
  the containing block of any fixed-position descendant, so menus, prompts and
  palettes render into `document.body` through a portal.

## Constraints imposed

- **A tab exists in one mode.** The backend refuses a move or a drop between
  the Editor's and Source Control's areas, and a file dropped on Source
  Control's.
- **A panel belongs to one mode.** `normalize` removes a panel from a tree of
  another mode, and a drop of a panel from another mode is ignored.
- **The work leaf is never removed and never becomes a tab**; it holds panels,
  and emptied regions collapse around it.
