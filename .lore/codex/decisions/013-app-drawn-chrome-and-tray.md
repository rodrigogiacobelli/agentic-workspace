---
id: 013-app-drawn-chrome-and-tray
title: 'ADR-013: App-drawn chrome and a tray-resident process'
summary: Why both windows run undecorated behind one 30 px row the application draws
  itself, why closing a window hides it into a tray icon instead of ending the process,
  how the workspace selector and the tray list each workspace family and where its
  attention shows, and what libappindicator's menu-only event model costs.
related:
- 001-two-os-windows
- 017-modes
- 018-mount-what-is-on-screen
- 020-workspace-family
- standards-linux-desktop
- operations-running-agentic-workspace
binds:
- src-tauri/src/tray.rs
- src-tauri/src/windows.rs
- src/components/Switcher.tsx
- src/components/Menu.tsx
---

# ADR-013: App-drawn chrome and a tray-resident process

## Context

Both windows carried a KDE title bar with the application's own workspace
selector under it — two bars of chrome above every document and every terminal.
Closing either window ended the process, and with it every terminal running
behind it.

Key forces:

- **The workspace selector cannot be given up.** Both windows show which
  workspace is active and can switch it (`001-two-os-windows`), and that
  control is the application's to draw whatever the compositor draws above
  it.
- **Closing a window is a cheap gesture with an expensive result.** Terminal
  sessions live in the backend (`002-backend-owned-terminal-sessions`), so a
  process that exits with the last window takes a running agent with it.
- **A window that is hidden and shown again has to come back as it was.**
  Geometry restored only at launch covers a relaunch and not an afternoon
  spent in the tray.
- **Wayland gives a client no control over its own toplevel position**
  (`standards-linux-desktop`), so geometry the application restores is a
  request the compositor may decline.
- **libappindicator is what a Plasma tray accepts.** A StatusNotifierItem
  registered through it delivers menu events and nothing else; no click event
  reaches the application.

## Decision

Both windows declare `decorations: false` in `src-tauri/tauri.conf.json` and
draw one 30 px **title row** in place of the title bar (CHR-01, CHR-08).
`src/components/Switcher.tsx` renders it: on the left the logo, the workspace
selector with its add, remove and rename actions, the attention badge and the
path of a missing workspace; the mode selector at the middle of the window,
whose Terminal and Editor buttons raise the other window (`017-modes`); and on
the right the View menu, the settings button, and minimise, maximise and close
in that order (CHR-03). The branch and repository state sit in the
application's status bar.

The title row carries `data-tauri-drag-region="deep"`, so Tauri's injected drag
script starts a compositor-side move from a press anywhere inside it other than
a button or an input, and toggles maximised on a double click (CHR-02, CHR-04).
The frontend draws the resize band itself — five-pixel edges and ten-pixel
corners, fixed over the page — and a press on it calls the window API's
`startResizeDragging`, which hands the resize to the compositor (CHR-05). tao
hit-tests the same band at the GTK level, but the webview consumes every pointer
event before the GTK window sees it, so that path never fires here. A right-click on an empty part of the title row calls
`windows::show_window_menu`, which hands GDK a synthetic button event carrying
the seat's pointer so `xdg_toplevel.show_window_menu` has the button serial it
requires (CHR-07).

Closing a window runs `windows::hide`: the geometry is recorded and the window
disappears while the process lives on in the tray (TRAY-01, TRAY-07).
`tray::menu` builds a first entry reading **Show** and `desktop::APP_NAME` —
**Show Agentic Workspace** from an installed build, **Show Agentic Workspace
(dev)** from a development one — then one checked entry per window, one checked
entry per open workspace, and **Quit** (TRAY-03, TRAY-04, TRAY-06). Quit and
the last-window close both route through the Workspace window, which owns the
unsaved-buffer prompt; it is the only window that listens for
`quit-requested`.

**The selector lists each workspace family in up to three levels.** A
workspace family (`020-workspace-family`) is a root — a workspace the owner
added by hand that is not listed under a repository's row — with its
children, the repositories found directly inside the root's folder, and its
worktree members, the linked worktrees of either that are open as workspaces.
`family::normalise` writes which is which into `Workspace.child_of` and
`Workspace.worktree_of`, and the selector and the tray both read those two
fields. `Switcher` draws each root as a top-level row. A root's disclosure
lists its worktrees — each open one as `⑂ name · branch`, then, under a
repository's main checkout, the ones git lists that no workspace has open —
followed by its children; a child's disclosure lists the child's
worktrees the same way (WS-12, WS-19). A root that lists both worktrees and
children gathers the worktrees under a `Worktrees` row, which opens or closes
on a click and offers no Rename or Remove; a root without children, and every
child, lists its worktrees directly (BR-13, BR-13a, BR-14a). A row with the
active workspace anywhere below it opens by itself whenever the list opens,
and one closed by hand opens again on the next opening (BR-14). A root row
offers Rename and Remove. A child row offers Rename, and Remove only while its
folder is missing (WS-17, WS-20, WS-16a). An open worktree row offers Rename
and no Remove, since Source Control's Worktrees panel deletes a worktree.
`RowMenu` in `src/components/Menu.tsx` indents each row by its depth.

**Rows reorder within their own list** (WS-11, WS-18). A row names the list it
belongs to in `Row.siblings`: the roots, or one root's children. `RowMenu`
lets a row take a drop only from a row of the same list, and gives no drag to
a worktree row, a `Worktrees` row or a row alone in its list. A drop lands
before the row it is on, after the last row of a nested list when it is on
that row's lower half, and last among the roots when it is on the footer.
`Switcher` then sends `reorder_workspaces` every id — each root, its worktree
members, then each child followed by its own — and `normalise` restores
that shape on every persist whatever list arrives, so a child stays among its
root's children and a worktree stays under its row. The session stores the
order, and the tray lists it.

**The tray lists what the selector lists** (TRAY-08). `tray::apply` puts each
root first, then its open worktree members prefixed `⑂ `, then each child
prefixed `› ` followed by the child's open worktree members prefixed `› ⑂ `.
Over the open worktree members of a root that also has children it puts a
disabled `Worktrees` entry. Worktrees git lists that nobody opened are offered
in the selector alone. Picking a workspace entry switches to that workspace on
a thread of its own, since bringing a workspace on screen runs git and a scan
and can start shells.

**Attention belongs to a family, on its root** (AGT-10, AGT-11). The root holds
the family's terminals, so `session::persist` sets the root's
`Workspace.attention` while a tab of its list has printed out of view since the
family last came on screen (`020-workspace-family`). Four marks read that
flag, and none of them marks the family on screen: the selector prefixes `● ` to the root's row, open or
closed, and to no member row; the title row shows its attention badge while
any root outside the family on screen wants attention; the tray prefixes `● `
to the root's entry; and `tray::icon` paints an orange dot into the corner of
the application icon (TRAY-05). Coming to any member of the family clears
the flag, and a tab that prints again raises it; each tab keeps its own mark
in the Terminal window until it is itself in front.

libappindicator's menu-only event model means the tray icon is built with
`show_menu_on_left_click(true)`: a left click opens the menu, and its first
entry, the one `desktop::APP_NAME` names, raises the window
`state.last_focused` names (TRAY-02). No handler sees a bare click.

`windows::record` keeps each window's size, position, maximised state and
monitor name in `windows.json` beside the session, keyed by window label;
`windows::show` applies them whenever a hidden window is shown, which is the
path a launch takes as well (FIX-03). Size and the maximised state are set;
position is requested and left to KWin (PLT-11), and
`operations-running-agentic-workspace` carries the window rule that pins it.

## Rationale

- One bar of chrome above a document instead of two, and the bar that remains
  is the title row, carrying the workspace and the mode.
- A hidden window rebuilds nothing when it returns: the webview, the editor
  state and the terminal attachment are all intact, so reopening is immediate
  and no agent loses its terminal.
- One store and one code path for geometry means hiding to the tray and
  relaunching restore a window identically.
- The tray menu is the one surface that reaches the application when no window
  is on screen, so it carries the windows, the workspaces and the way out.
- The selector and the tray draw one tree from the two fields `normalise`
  computes, so a worktree or a child sits under the same row in both.
- A `Worktrees` row separates a root's worktrees from its repositories only
  where the root holds both; elsewhere it would be one more click between the
  owner and a worktree.
- A family's attention sits on its root because the root holds the family's
  terminals and every member shows them: coming to any member is coming to
  the output that raised it.
- A dot drawn into the icon is the only signal available to a process whose
  windows are all hidden.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Keep the KDE decorations** | Costs nothing to build and matches every other window on the desktop, and the title row then sits under a second title bar, doubling the chrome above every document and every terminal. |
| **Quit when the last window closes** | The conventional behaviour for a document application, and it destroys the running terminals that `002-backend-owned-terminal-sessions` exists to keep. |
| **An own StatusNotifierItem over zbus** | Delivers the click events libappindicator withholds, at the cost of implementing the dbusmenu protocol to satisfy one criterion that the menu's first entry satisfies already. |
| **A `Worktrees` row under every repository** | One shape for every row, and a click more to reach a worktree under a repository that holds nothing else to tell it from. |
| **An attention dot on the member a shell's directory lies in** | Names where the output came from, and marks a row that holds no terminal of its own: the tab is in the root's list, which every member shows. |

## Consequences

**Easier:**
- Reopening a closed window costs no rebuild of any kind.
- Window geometry has one writer, one file and one restore path.
- The tray menu switches workspace and raises a window with no window on
  screen.

**Harder:**
- Every affordance a title bar supplied is the application's to draw and wire:
  the drag, the double-click, the window menu, the three buttons.
- The button order is fixed at minimise, maximise, close; Plasma's configured
  order is not read.
- A desktop with no StatusNotifierItem host leaves the application without a
  tray. `tray::init` fails, `setup` emits a notice saying so, and
  `on_close_requested` then runs the quit path when the last visible window is
  closed.
- The tray menu is rebuilt from the session whenever it is published, so
  `tray::refresh` compares a signature first and skips a rebuild that would
  change nothing, rather than replacing an open menu under the pointer. It
  sets the icon only when the attention dot comes or goes, since GTK decodes
  each icon it is handed in a sandboxed image loader.
- A drag in the selector is scoped to one list, and WebKit hides a drag's data
  until the drop, so `RowMenu` holds the dragged row and its list in a ref from
  `dragstart` to decide which rows accept it.

## Constraints imposed

- **Closing hides, never destroys.** A window is hidden for the life of the
  process, so no editor buffer, terminal attachment or scroll position is
  rebuilt when it returns.
- **Only Quit ends the process.** The tray menu's last entry, `Ctrl+Q` and the
  window controls all reach `session::quit` by way of the Workspace window,
  which prompts about unsaved buffers, saves the session and the geometry, and
  reaps every shell.
- **Position is requested, never asserted.** The application restores size and
  the maximised state and reports no placement it did not achieve.
- **The tray icon is a packaged dependency.** `bundle.linux` declares
  `libayatana-appindicator3-1` for the deb and `libayatana-appindicator-gtk3`
  for the rpm (PLT-09).
