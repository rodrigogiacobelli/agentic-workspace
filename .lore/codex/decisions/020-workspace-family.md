---
id: 020-workspace-family
title: 'ADR-020: A workspace added by hand heads a family that shares one terminal list'
summary: Why a workspace the owner adds by hand is the root of a workspace family
  — the repositories directly inside its folder, found by one directory listing and
  saved as child entries marked by their id, and the worktrees of each, saved under
  their repository's row — why the family shares one terminal list on its root, with
  attention, notifications and terminal credentials per family, why discovery looks
  down one level and never up, why the session stays format 2 so v0.4.0 reads it and
  every load places the entries again, and what the scan costs.
related:
- 007-workspace-is-one-directory
- 002-backend-owned-terminal-sessions
- 015-views-and-citations
- 018-mount-what-is-on-screen
- 019-credentials-through-the-secret-service
- 004-central-settings-store
- 013-app-drawn-chrome-and-tray
- 016-terminal-output-and-renderer
- 017-modes
- vision-agentic-workspace
binds:
- src-tauri/src/family.rs
- src-tauri/src/state.rs
- src-tauri/src/session.rs
- src-tauri/src/pty.rs
- src-tauri/src/agent.rs
- src-tauri/src/watch.rs
- src-tauri/src/tray.rs
- src/modes.ts
- src/App.tsx
- src/components/Switcher.tsx
- src/components/TerminalWindow.tsx
- src/components/WorktreesPanel.tsx
---

# ADR-020: A workspace added by hand heads a family that shares one terminal list

## Context

Terminals belonged to one workspace entry. A linked worktree opened as a
workspace got a list of its own with a fresh shell in it, and the Terminal
window showed only the active workspace's list, so the agent running at a
repository's root was out of sight whenever one of its worktrees was on
screen. The owner moves between the two all day: the agent works at the root,
and the files it produces are read in the worktree.

Nothing looked inside a workspace's folder for repositories. The owner's
`/home/kk/camelot` is a plain folder holding five repositories — `camelot/`,
`citadel/`, `lore/`, `realm/` and `realm-deploy/` — and the owner asked for
three things: adding camelot lists them; adding `lore` by hand gives `lore`
and what is inside it, never its parent; and terminals are shared per
workspace the owner added by hand, not per repository found inside one.

Key forces:

- **Every subsystem needs one root** (`007-workspace-is-one-directory`). The
  Explorer, Source Control, search and asset paths each resolve against one
  directory, and git acts on one repository.
- **The installed v0.4.0 AppImage reads the same `session.json`.** Its
  `store::load` moves aside a session whose format is newer than 2 and starts
  with no workspaces, and its save drops every key it does not know.
- **A workspace out of sight is quiet** (`018-mount-what-is-on-screen`): no
  watch on its tree, no working-tree read, and git only when its git
  directory changes.
- **A terminal's credentials reach one repository, on consent**
  (`019-credentials-through-the-secret-service`).
- **A repository found in a folder may never be opened.** Each one listed
  costs a row, watches on its git directory and a git summary.

## Decision

**A family: a root, its children and their worktrees.** A **root** is a
workspace the owner added by hand that is not listed under a repository's
row. A **child** is a git repository found directly inside a root's folder. A
**worktree member** is a linked worktree of a root's repository or a child's,
open as a workspace and listed under that repository's row. A root with its
children and worktree members is its **workspace family**. A worktree git
lists that nobody opened is offered under its repository's row and is not a
member. A linked worktree added by hand whose repository is not open is a
root of its own.

The workspace family decides what the selector and the tray list, which
terminal list a member shows, where attention appears, and which open
workspace a click routes a file to. It does not decide what a document may
load: that is the worktree family of `015-views-and-citations`
(`tree::family`), a separate relation.

Every member is a full workspace entry (`Workspace`, `state.rs`) on one
directory, with its own editor tabs, expanded folders, mode, views and git
summary (WS-13). A child is marked by its id, which starts `child-`
(`family::CHILD_MARK`) and holds no `:`, the character the windows split
their kept-state keys on. A child's root is not stored: it is the root whose
folder is the child's parent folder. A worktree member's row is saved in
`openedUnder`. `childOf` and `worktreeOf` are computed for the windows,
written with the session, and never read back.

The selector and the tray (`013-app-drawn-chrome-and-tray`) list each root,
then its worktree members — under a `Worktrees` row when the root has
children as well (BR-13, BR-13a) — then each child followed by its own
worktrees. A child drags only among its root's children, and a worktree row
does not drag (WS-18). The workspace quick switch in `src/App.tsx` gives a
child or a worktree member the row it is listed under as its detail line,
`camelot › lore`, and a root its path (WS-26).

**Discovery: one listing, down one level.** `family::scan` takes the root's
path under the session lock, lets the lock go, and reads the folder with one
`read_dir`. An entry whose name does not start with `.`, that is a directory
and not a symlink, and that holds a `.git` directory is a repository (WS-12).
A `.git` file — a linked worktree, a submodule — makes no child, and nothing
below the first level is read (WS-15, WS-15a). No git process runs. Under the
lock again, `family::new_children` picks, in name order, each repository with
no child entry on its folder, and `scan` appends a new entry for each, with no
terminal, so that it lists after the children already there (WS-16,
assumption 6).

- A scan never removes or renames an entry (WS-17a). A child whose folder has
  gone stays listed, marked unavailable, with its name, place and tabs, and is
  available again when a repository is back at its path (WS-16a). Its row
  offers *Rename*, and *Remove* only while it is unavailable (WS-20);
  removing it takes its worktree members.
- A root whose folder cannot be read adds nothing, and neither does a root
  whose `.git` names a repository that cannot be read
  (`credentials::Top::Unresolved`), as a worktree's does while its repository
  is away.
- Only a root scans (`family::scans`). A child never does, so a repository
  inside a child is never listed under the root (WS-15); that child's folder
  added by hand is a root, and lists it.
- A linked worktree that is a root lists the repositories inside its folder.
  When its repository opens and it goes under that row (TERM-25), the children
  it listed stay as top-level entries that do not scan, until that folder is a
  root again. A child whose root v0.4.0 removed stands the same way, and
  adding the root again takes it back.

The scan runs when a root is added; at launch for every root
(`family::scan_roots`, linked-worktree roots last, so a worktree that another
root's scan gives a row goes under it before it lists anything); whenever any
member of a family comes on screen, where `session::activate` scans the
family's root; and when the watcher reports a folder made, moved or removed
directly inside the root of the family on screen (assumption 27). A clone
into the root's folder is listed within one watcher settle (WS-16). `git
init` inside a folder that already exists raises no event at the root, and
the folder is listed at the next activation of a member. A child that holds
no summary — one a scan added, or one back from away — has it read at once,
giving its branch and its worktrees (WS-19): after an add or a switch,
`family::settle` reads it on a thread of its own, then syncs the watches and
publishes; after a watcher event, the watcher's thread reads it.
`family::summarise` claims each id it reads in `AppState.summarising`, so a
switch during launch never reads a summary the launch pass is reading.

**Placement: from the files git keeps, never from git.** `family::normalise`
decides which entries are children and of which root, which worktree hangs
under which row, and the order. It reads the session and each entry's
`repository`, the repository at the entry's own directory.
`credentials::repository_at` reads it from `<path>/.git` at load
(`family::read_repositories`) and in `add_workspace`, `scan` sets it on a
child it makes from the `.git` directory it found, and it is never saved.
`normalise` does no I/O, so it can run under the session lock. It runs at
load, first in every `session::persist`, and after every add, removal and
scan, and it is idempotent.

- A **row** is any entry that is not a linked worktree: a root, a child, or a
  child standing without its root. A worktree goes under its saved
  `openedUnder` while that is still a row on its repository. With none saved,
  as in a file v0.4.0 wrote back, it goes under the nearest row before it in
  session order when that row is on its repository, else under the first row
  on its repository, else it is a root (WS-23, assumption 10). A worktree is
  never listed under a worktree.
- An entry whose `.git` cannot be resolved, such as a worktree whose
  repository's folder is away at launch, keeps its saved row (WS-22).
- The order is each root, its worktree members, then each child followed by
  its own. `reorder_workspaces` accepts any list, and `normalise` puts every
  child back inside its root and every worktree after its row. An entry the
  walk misses keeps its place at the end rather than leave the session.

`add_workspace` switches to a root already on the folder, a child on it not
counting (WS-14), or, for a linked worktree, to any entry on it: a worktree
folder is open at most once (assumption 29). Otherwise a linked worktree goes
under `family::row_for`: the row it was picked from, or the one Source
Control opened it from — the workspace on screen, or that workspace's row
when it is a worktree — else a row on its repository in the family on
screen, else the first in session order (WS-25, assumption 4). A new root
starts one shell in its folder; a new worktree member starts none (TERM-20).
`add_workspace`, `remove_workspace` and `terminal_open` run off the main
thread, and so does a pick from the tray.

`remove_workspace` takes the entry with everything `Session::listed_under`
names — a root its whole family, a child its worktree members — and hangs up
their shells. No file on disk is touched (WS-21). The confirmation names each
workspace going with it, counts the shells it closes, and names each member
holding unsaved buffers. When the workspace on screen went, the most recently
used one left comes on screen, else the first left, else the empty state. A root the owner
added on a folder inside the removed root heads a family of its own and
stays. `prune_worktrees` drops an entry opened from a worktree list whose
folder has gone only when it is not on screen, holds no terminal and has
nothing listed under it, and never drops a child.

**One terminal list per family, on the root.** Whenever the session lock is
released, only a family's root holds `terminals` and `active_terminal`.
`normalise` moves any other entry's tabs to the end of its root's list with
their ids, names and directories (TERM-21, TERM-21b); tabs moved from the
member on screen keep its tab in front (TERM-21a). `AppState.ptys` keys a
shell by its tab id, so a moved tab keeps its running process (TERM-25).
`Session::family_root`, and `familyRoot` and `familyOf` in `src/modes.ts`,
resolve any member to its root; `pty::ensure_live`, `terminal_open`,
`set_active_terminal` and `reorder_terminals` take any member and act on the
root's list. A family has one tab in front (assumption 9), and every member
shows the same tabs (TERM-16).

- A tab opened without a directory starts where the global setting
  `terminalOpenIn` says: `root`, the default, in the root's folder, or
  `workspace`, in the folder of the member on screen (TERM-17, TERM-18).
  *Open terminal here* passes its folder and ignores the setting (TERM-18a).
  Either way the tab joins the family's list, in front.
- A tab's label is followed by where its shell is: nothing in the root's
  folder, the child's name in a child's, `⑂ <name>` in a worktree's. The
  deepest member holding the tab's directory decides (`memberHolding`,
  TERM-19).
- A path printed in a family shell opens in the member of the family that
  holds it: the member on screen when it does, else the deepest. A path in no
  member raises a notice naming it (TERM-24).
- A root whose folder is missing does not strand its family.
  `pty::ensure_live` starts each tab in its own directory, else in the root's
  folder, else in the folder of the member on screen, and `terminal_open`
  falls back to that member (TERM-26). `ensure_live` returns one notice naming
  the missing folder, on the family's first spawn, for its caller to raise; at
  launch, while no window listens, the notice waits in `AppState.notices` for
  the first window to take it.
- Deleting a worktree from Source Control's Worktrees panel reads the session
  again, which reads every shell's directory from `/proc/<pid>/cwd`. The
  confirmation names every tab of any family whose directory is inside the
  worktree, and every tab of the workspace open on it when that workspace is a
  root. Confirming closes those tabs, removes the workspace, then runs `git
  worktree remove` (TERM-22). A worktree or child that disappears outside the
  application closes no shell (assumption 28).

**Attention, notifications and credentials per family.** Output from a tab
out of view puts it in `AppState.attention`, and the tab keeps its own mark
until it is in front. `session::persist` sets a root's `attention` — its `●`
in the selector, the title row's badge and the tray — from its tabs, leaving
out those in `AppState.seen`: tabs whose family has come on screen since they
printed. `session::activate` adds the family's marked tabs to `seen`, and
`agent::on_output` takes a tab out again when it prints. No member row
carries `●`, and the root's is hidden while any member is on screen (AGT-10,
AGT-11); the Terminal button's dot then says a family shell printed.
`agent::quiet_loop` notifies nothing for the family on screen. For a family in
the background, the root's per-folder notification setting governs and the
notification names the root (AGT-12); a click on it switches to the member of
that family last on screen, else the root, and raises the Terminal window on
the tab (AGT-13). Family shells start with the root's terminal environment:
its terminal option, key, identity and include patterns (CRED-14, CRED-15,
`019-credentials-through-the-secret-service`). A member's Workspace settings
page says that its family's notifications and terminal credentials follow the
root, in place of its own Notifications choice and terminal option (AGT-12,
CRED-16).

**Two entries on one folder.** A root the owner added and a child a scan
found may sit on one folder (assumption 3). They share that folder's one
settings entry (`004-central-settings-store`) and its drafts, which are filed
by absolute path. Where a click routes a file to the open workspace holding
it, a member of the family on screen wins: the Workspace window's
`workspaces()` hook lists that family first, and the document resolver keeps
that order among entries on one folder (CITE-23). The Worktrees panel picks
this family's entry the same way. A worktree open only under the other family
is opened there, switching families (assumption 29).

A root's folder holds its children's, so one file can be open in a root and
in a child at once. A rename or a move made in the tree reaches every open
workspace whose folder holds both the old and the new path:
`session::relocate` renames the tabs, recent files, view entries and open
folders that name it there, and moves the draft of each moved tab (TREE-26c).
A *Replace* from the tree closes the tabs on the replaced file in every
workspace that holds it, and `FileTree` refuses it, naming the tab, while any
of them holds unsaved text.

**The session stays format 2.** `SESSION_VERSION` is 2, and the family's one
saved field, `openedUnder`, has a default (assumption 26). v0.4.0 reads a
session saved with a family: `Workspace` has no `deny_unknown_fields` and
flattens its editor area, whose deserializer ignores the keys v0.4.0 does not
know. v0.4.0 lists every entry — children as top-level rows, each worktree
under the first row on its repository — and starts (WS-23a). Its save keeps
ids, names, order and terminals and drops `openedUnder` and `childOf`. Read
back, the `child-` id and the root's folder restore every child, the order
restores every worktree's row, and the load moves every tab v0.4.0 opened
under a member to its root's list (TERM-21b). Its settings save drops
`terminalOpenIn` and `confirmDelete`, which then read `root` and on.

## Rationale

- The agent works at the root while its output is read in a worktree or a
  child. One list with one tab in front keeps the agent's tab on screen across
  that switch, with no shell restarted.
- Each member stays one directory, so the Explorer, Source Control, search
  and asset paths keep `007-workspace-is-one-directory`'s single root; only
  terminals, attention and click routing span the family.
- A child saved as an entry keeps its tabs, name and place across restarts and
  scans (WS-17a, WS-22). A child offered from a git summary, as unopened
  worktrees are, would have nothing of its own to keep, and nothing to list
  before git runs.
- Placement read from `.git` files places every worktree and starts the
  family's shells at launch before any git process, and with no git on `PATH`
  (TERM-21a, WS-22).
- One listing of a folder the owner chose lists what the owner keeps there
  and nothing deeper. It starts no git and runs on events that happen anyway —
  an add, a launch, a switch — and on one non-recursive watch of the family
  root's folder, which reaches only the scan and the workspace on screen while
  the root is out of sight, so a background root stays quiet
  (`018-mount-what-is-on-screen`). Measured headless: a repository cloned into
  a root's folder was listed 164 to 175 ms after the clone finished in four
  runs, and a switch to a root runs no git in its known children.
- A mark in the id survives v0.4.0, which writes ids back unchanged and drops
  unknown keys, and the saved order carries each worktree's row through the
  same round trip. Measured with the installed v0.4.0 AppImage on a family
  session: it listed every entry and started, and the session it saved read
  back as the same tree, names, order and terminals.
- `seen` clears a root's `●` on coming to any member while each tab keeps its
  own mark, which clearing the tabs' attention on a switch would erase.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Raise `SESSION_VERSION` for the family's fields** | Declares the new shape, and v0.4.0 moves a newer session aside, so a rollback to the installed AppImage opens with no workspaces. |
| **A saved `childOf` field as a child's mark** | Explicit, and v0.4.0 drops it at its next save: every child would then read as a root, and the next scan would add a second child on each folder. |
| **Children offered from each root's summary, never saved** | No new entries and no cascade on removal, and a child then has no tabs, name or order of its own to keep, and nothing is listed before git runs. |
| **A session-level terminal map keyed by the repository's common git directory** | Known from disk at launch and outlives a root's removal, and needs a format bump, rewrites every terminal lookup, has no key for a plain-folder root such as camelot, and shares one list between worktrees whose repository is not open, which the selector shows as separate roots. |
| **Scanning deeper than one level** | Finds `camelot/tools/gen`, and walks `node_modules`, `target` and `.venv` on every scan. A deeper repository is added by hand as a root of its own. |
| **Children that list the repositories inside them** | Puts generated and vendored repositories under every child; a repository inside a child is reached by adding the child's folder by hand. |
| **Grouping hand-added workspaces by containment** | Would move a `lore` added by hand under a `camelot` added later. A workspace added by hand stays a root; discovery looks down, never up (WS-14). |
| **A linked-worktree root that lists nothing** | Nothing is left standing when the worktree later joins its repository, and a folder added by hand would list what is inside it only when it is not a worktree. |
| **Clearing the family's tab attention when a member comes on screen** | Meets AGT-11 with no second set, and erases each tab's own mark on every switch into the family. |

## Consequences

**Easier:**
- The agent's tab stays in front, output and process intact, across any
  switch within its family.
- A folder of repositories is one add: each repository in it is listed with
  its own tabs, git and worktrees.
- A family's shells start at launch with git absent.
- The owner can run v0.4.0 on a session and come back without losing an
  entry, a name, a place or a terminal.

**Harder:**
- Every child costs a row, five watches on its git directory, and a summary
  at launch and on every change there — three git processes, four on a branch
  with no commit yet — whether or not the owner opens it; a root added by hand
  on the same folder doubles the summaries. No child can be hidden.
- Two entries on one folder share one settings entry and one draft per file:
  a Notifications choice or an assigned key made for one applies to the
  other, and unsaved text in one is the other's draft.
- A plain-folder root has no ignore rules: `git check-ignore` fails outside a
  repository, so its Explorer and quick open show its children's ignored files
  at full weight.
- A folder turned into a repository by `git init` is listed only when a
  member of its family next comes on screen.
- A shell inside a worktree or child deleted outside the application keeps
  running in the deleted folder.
- A linked-worktree root that joins its repository leaves the children it
  listed as top-level entries that do not scan, keeping their summaries and
  watches until the owner removes them or adds that folder again.
- One order misreads a v0.4.0 round trip: a worktree v0.4.0 appended right
  after the later of two rows on one repository goes under that later row,
  where v0.4.0 listed it under the earlier.
- `normalise` runs under the session lock on every persist: passes over the
  entries, quadratic in their number, with no I/O.

## Constraints imposed

- **Discovery looks down one level and never up.** Only a root scans, a child
  never does, nothing below the first level is read, and a workspace added by
  hand never moves under another.
- **A scan only adds.** It never removes, renames or reorders an entry. A
  child leaves the session with its root, or by the owner's *Remove* once its
  folder is gone.
- **Placement starts no git.** `normalise` does no I/O, and an entry's
  repository is read from its own `.git`, never from an ancestor's.
- **Only a family root holds terminals.** Code that reaches a workspace's
  terminals resolves its root first: `Session::family_root` in the backend,
  `familyRoot` in the windows.
- **The session stays readable by v0.4.0.** `SESSION_VERSION` stays 2, a
  saved field carries a default, a computed field is never read back, and a
  child's mark lives in its id.
- **A worktree folder is open at most once.**
- **Only a delete confirmed in the Worktrees panel closes shells.**
