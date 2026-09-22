# Agentic Workspace

A native Linux desktop app for running several agent-driven projects at once —
without losing the one you just switched away from.

> **Status: seven milestones.** Workspaces, the two windows, terminals that
> survive a switch, the file tree, session restore, the three-mode markdown
> editor, git with worktrees, the two agent signals, app-drawn window chrome
> over a tray-resident process, draggable editor splits and panels, custom
> views, path citations and the typing helpers run. `.lore/codex/` holds the
> decisions behind it.

---

## The problem

Start `claude` in project X. Start a dev server beside it. Open the project's
docs, read, edit, prompt the agent again. Now switch to project Y and do the
same.

With an editor and a terminal emulator, that switch costs you the setup. Windows
pile up, terminals get closed, and you rebuild the same arrangement every time
you come back. The agent you left running in X is somewhere behind eleven other
windows, and you have no idea whether it finished.

## The idea

A **workspace** is one directory, and it owns everything about that project: its
file tree, its open documents, its terminals. Switching workspace swaps all of
it at once. The terminals you left behind keep running — same processes, same
output, just out of sight — and they are exactly as you left them when you come
back.

```
  ┌─ Workspace window ──────────┐   ┌─ Terminal window ───────────┐
  │ agentic-workspace      ▾    │   │ agentic-workspace      ▾    │
  ├─────────┬───────────────────┤   ├─────────────────────────────┤
  │ .lore/  │ # Rite Design     │   │ [claude] [server] [git] +   │
  │ src/    │                   │   │                             │
  │ notes/  │ A rite is proce…  │   │ > refactor the parser       │
  │ README  │                   │   │ ✓ edited src/parse.rs       │
  └─────────┴───────────────────┘   └─────────────────────────────┘
       ↑ switch either window, both follow
```

## What it does

**Two windows.** A Workspace window (file tree and editor) and a Terminal
window, each a real OS window you can put on its own monitor or virtual desktop.
Both always show the same project; a hotkey raises the other.

**One row of chrome, and a tray.** Neither window has a KDE title bar. A single
30 px title row carries the workspace selector, the branch, the path, the
settings button and the window controls, and it drags, double-click-maximises,
snaps and resizes the window exactly as a title bar does. Closing a window hides
it — the app stays in the tray with every terminal still running, and the tray
menu shows a window, switches workspace or quits.

**Terminals that survive the switch.** Tabbed, full-fidelity terminals — good
enough for `claude`, `tmux` and `vim`. Switch away and they keep running. Come
back and everything they printed is there. Quit for the day and tomorrow the
tabs return with their working directories, ready for you to relaunch.

**A markdown editor that edits both sides.** Three modes: raw source, a split
with source on one side and the rendered document on the other, and a
full-width rich editor. The rendered side is *editable*, not a preview — which
is the part your editor's markdown preview doesn't do.

**It never reformats what you didn't touch.** Edit one paragraph in the rendered
pane and exactly that paragraph's bytes are rewritten. Your bullet characters,
your emphasis style, your hand-wrapped lines and your frontmatter stay as you
wrote them.

**Tabs that don't pile up.** A single click in the file tree opens a preview
tab, labelled in italics, which the next single click replaces. Editing it,
double-clicking it or dragging it makes it permanent.

**A layout you drag into shape.** Drop an editor tab on a group's edge to split
the area in that direction, on its centre to move it there, and drag any divider
to resize. The Files, Search, Git and Outline panels move the same way — onto
any edge of any region, or into another region's tab strip — so a panel can sit
left, right or below the editor. A panel closed from its tab comes back from
the title row's *View* menu or its hotkey. Editor splits belong to the
workspace; panel placement belongs to the app.

**Custom views.** A view is a named list of shortcuts into the workspace. Send
files and folders to it from the file tree and they sit at its root whatever
their depth on disk, each folder expanding to its real children. Nothing is
copied and nothing is moved; deleting a view deletes the list.

**Paths an agent can read.** *Quote to AI* on any file or folder writes
`@path/from/the/workspace/root` into the document you are editing — one line
per file when several are selected. In the rendered view a cited image, audio
file or video plays inline, everything else is a chip you can click to open, and
a citation to a file that is not there is marked in red. One setting decides
whether pasting and dropping write a citation or a markdown link relative to the
note.

**Paste images and audio straight in.** They land in the project's clipboard
folder, get a link, and render inline — images shown, audio playable, without
leaving the document.

**Typing helpers.** Several cursors, column selection, moving and copying lines,
line comments, bracket pairs that wrap a selection, `Tab` to nest a list item
and `Alt+C` to tick a task box. They work in every view of a document, the
rendered one included.

**Git, including worktrees.** Status, diffs, hunk staging, commits, history and
blame. Plus branches and worktrees, because a project here is often *itself* a
worktree of another one — and creating one offers to open it as a new workspace.

**It tells you when an agent needs you.** A workspace you left running gets an
attention badge when its terminal produces output, and an optional desktop
notification when a busy terminal goes quiet — the agent finished, or it is
waiting for your answer. With every window closed, the tray icon carries the
same signal.

## What it is not

Not an IDE. There are no language servers, no autocomplete, no debugger, no
extension host. The editor highlights markdown, HTML, JSON, TOML and YAML, and
opens everything else as plain editable text. This is a tool for **more text,
less code** — the code is the agent's job.

## Built for

Arch Linux and CachyOS, KDE Plasma, Wayland. Rust and Tauri v2. Other Linux
desktops are best-effort; other operating systems are out of scope.

## Documentation

| Where | What |
|---|---|
| `.lore/codex/vision/` | What the product is for |
| `.lore/codex/decisions/` | ADRs — why each shape was chosen, and what was rejected |
| `.lore/codex/standards/` | The rules the code has to comply with |
| `.lore/codex/operations/` | Running it, building it, installing it, starting it at login, and why it will not start |

The in-flight specification — every behaviour as Given/When/Then — lives at
`working/acceptance-criteria.md` and `working/acceptance-criteria-2.md`, neither
version controlled. Their facts move into the codex as they are built.

Project knowledge lives in Lore. `lore codex list` is the index.

## Building it

Arch / CachyOS:

```bash
sudo pacman -S --needed base-devel webkit2gtk-4.1 gtk3 libayatana-appindicator \
  rustup nodejs pnpm git ripgrep glib2 libnotify
```

`src-tauri/Cargo.toml` sets the Rust floor at 1.88; `rustup default stable`
meets it.

> **Fish users:** `~/.cargo/env` is bash syntax and errors under fish. Use
> `source ~/.cargo/env.fish`, or persist it with `fish_add_path ~/.cargo/bin`.

```bash
pnpm install
pnpm tauri dev          # development: both windows, hot reload
pnpm release            # deb / rpm / AppImage under src-tauri/target/release/bundle/
cd src-tauri && cargo test --lib     # unit tests; no compositor or PTY needed
```

`lore codex show operations-running-agentic-workspace` carries the rest:
what each package is linked against, where the app keeps its state, how to
install an AppImage and replace it with a newer build, how to start it at login
under KDE, and the four failures that stop it before a window appears.

## Keys

| Key | Where | Does |
|---|---|---|
| `Ctrl+Shift+P` | both | Switch workspace |
| `Ctrl+Shift+Space` | both | Focus the other window |
| `Ctrl+Q` | both | Quit |
| `Ctrl+Alt+A` | anywhere | Raise the window you last used (bound through the desktop portal; reassign it in System Settings → Shortcuts) |
| `Ctrl+Shift+T` / `Ctrl+Shift+W` | terminal | New / close terminal tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | both | Next / previous tab |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | terminal | Copy / paste |
| `Ctrl+Shift+F` | terminal / workspace | Search the scrollback / the Search panel |
| `Ctrl+Shift+E` | workspace | The Files panel |
| `Ctrl+Shift+G` | workspace | The Git panel |
| `Ctrl+Shift+O` | workspace | The Outline panel |
| `Ctrl+P` | workspace | Quick open a file |
| `Ctrl+S` / `Ctrl+W` | workspace | Save / close the editor tab |
| `Ctrl+E` | workspace | Cycle the markdown editor: source → split → rich |
| `Ctrl+\` / `Ctrl+Alt+\` | workspace | Split the editor area / move the tab to the next group |
| `Ctrl+,` | both | Settings |
| `Ctrl+Alt+Shift+C` | workspace | Copy the selected path, relative to the workspace |

A panel hotkey selects and focuses that panel wherever you have docked it, and
brings it back if you closed it.

Inside a document:

| Key | Does |
|---|---|
| `Alt`+click | Add a cursor there |
| `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | Add a cursor on the line above / below |
| `Shift+Alt`+drag | Select a rectangle |
| `Ctrl+D` | Select the next occurrence of the selection |
| `Escape` | Collapse back to one cursor |
| `Alt+↑` / `Alt+↓` | Move the line up / down |
| `Shift+Alt+↑` / `Shift+Alt+↓` | Copy the line up / down |
| `Ctrl+J` | Join the next line onto this one |
| `Ctrl+/` | Toggle a line comment |
| `Tab` / `Shift+Tab` | Nest / un-nest a list item |
| `Alt+C` | Toggle a task checkbox |

In the rendered markdown view, syntax shows on the lines the cursor touches and
is hidden elsewhere; `Ctrl`+click follows a link. Paste an image or drop a file
onto a document and it lands in the workspace's clipboard folder; Settings →
*Asset links* decides whether the document gets a markdown link relative to the
note or an `@` citation from the workspace root.

Themes: four built in, and Settings → Import… reads a VS Code theme from a
`.json` or a `.vsix`, reporting what it could not map. A theme can be set per
workspace so projects are distinguishable at a glance.

Git runs through the `git` binary on your machine, so hooks run and your
configuration applies. Desktop notifications go through `notify-send`; clicking
one switches to the terminal that went quiet.

`Ctrl`+click a path or URL printed in a terminal to open the file at that line
in the Workspace window, or the URL in your browser. The ✎ button in the title
row renames a workspace; the path underneath does not change.

Double-click a terminal tab to rename it; drag tabs to reorder them. Right-click
in the file tree for file operations, for *Quote to AI*, and for *Send to* a
view; deleting moves to the trash through GIO.
