---
id: 013-app-drawn-chrome-and-tray
title: 'ADR-013: App-drawn chrome and a tray-resident process'
summary: Why both windows run undecorated behind one 30 px row the application draws
  itself, why closing a window hides it into a tray icon instead of ending the process,
  and what libappindicator's menu-only event model costs.
related:
- 001-two-os-windows
- standards-linux-desktop
- operations-running-agentic-workspace
binds:
- src-tauri/src/tray.rs
- src-tauri/src/windows.rs
- src/components/Switcher.tsx
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
`src/components/Switcher.tsx` renders it: the workspace selector, the attention
badge, the branch and repository state, the add, remove and rename buttons, the
workspace path, the settings button, the button that raises the other window,
and minimise, maximise and close right-aligned in that order (CHR-03).

The title row carries `data-tauri-drag-region="deep"`, so Tauri's injected drag
script starts a compositor-side move from a press anywhere inside it other than
a button or an input, and toggles maximised on a double click (CHR-02, CHR-04).
tao hit-tests pointer motion and button presses against a five-pixel band at
every edge and corner of an undecorated resizable window, which is what resizes
it (CHR-05). A right-click on an empty part of the title row calls
`windows::show_window_menu`, which hands GDK a synthetic button event carrying
the seat's pointer so `xdg_toplevel.show_window_menu` has the button serial it
requires (CHR-07).

Closing a window runs `windows::hide`: the geometry is recorded and the window
disappears while the process lives on in the tray (TRAY-01, TRAY-07).
`tray::menu` builds **Show Agentic Workspace**, one checked entry per window,
one checked entry per workspace with a dot against any background workspace
wanting attention, and **Quit** (TRAY-03, TRAY-04, TRAY-06). `tray::icon`
paints an orange dot into the corner of the application icon while a background
workspace wants attention (TRAY-05). Quit and the last-window close both route
through the Workspace window, which owns the unsaved-buffer prompt.

libappindicator's menu-only event model means the tray icon is built with
`show_menu_on_left_click(true)`: a left click opens the menu, and its first
entry, **Show Agentic Workspace**, raises the window `state.last_focused` names
(TRAY-02). No handler sees a bare click.

`windows::record` keeps each window's size, position, maximised state and
monitor name in `windows.json` beside the session, keyed by window label;
`windows::show` applies them whenever a hidden window is shown, which is the
path a launch takes as well (FIX-03). Size and the maximised state are set;
position is requested and left to KWin (PLT-11), and
`operations-running-agentic-workspace` carries the window rule that pins it.

## Rationale

- One bar of chrome above a document instead of two, and the bar that remains
  is the title row, carrying the workspace, the branch and the path.
- A hidden window rebuilds nothing when it returns: the webview, the editor
  state and the terminal attachment are all intact, so reopening is immediate
  and no agent loses its terminal.
- One store and one code path for geometry means hiding to the tray and
  relaunching restore a window identically.
- The tray menu is the one surface that reaches the application when no window
  is on screen, so it carries the windows, the workspaces and the way out.
- A dot drawn into the icon is the only signal available to a process whose
  windows are all hidden.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Keep the KDE decorations** | Costs nothing to build and matches every other window on the desktop, and the title row then sits under a second title bar, doubling the chrome above every document and every terminal. |
| **Quit when the last window closes** | The conventional behaviour for a document application, and it destroys the running terminals that `002-backend-owned-terminal-sessions` exists to keep. |
| **An own StatusNotifierItem over zbus** | Delivers the click events libappindicator withholds, at the cost of implementing the dbusmenu protocol to satisfy one criterion that the menu's first entry satisfies already. |

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
  change nothing, rather than replacing an open menu under the pointer.

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
