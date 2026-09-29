# Agentic Workspace

A native Linux desktop app for running several agent-driven projects at once —
without losing the one you just switched away from.

> **Status: four rounds.** Workspaces, the two windows, terminals that
> survive a switch, the file tree, session restore, the three-mode markdown
> editor, git with worktrees, the two agent signals, app-drawn window chrome
> over a tray-resident process, draggable editor splits and panels, custom
> views, path citations, the typing helpers, the Editor, Source Control and
> Terminal modes, an SSH key and commit identity per workspace, drag and drop
> in the Explorer, and change marks in the editor run. `.lore/codex/` holds the
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

**Three modes.** The Workspace window is in one of two modes: *Editor*, for
writing and reading documents, or *Source Control*, for reviewing and
committing. *Terminal* is the third, drawn in the Terminal window. Each mode has
its own panels, its own tabs and its own layout, so a diff never lands among
your documents. Switching mode — or workspace — brings back exactly what you
left: the same tabs, the same scroll, the same cursor. Each workspace remembers
which mode you were in.

**One row of chrome, and a tray.** Neither window has a KDE title bar. A single
30 px title row carries the workspace selector, the mode selector, the settings
button and the window controls, and it drags, double-click-maximises, snaps and
resizes the window exactly as a title bar does. Mode buttons and panel tabs read
as labels or as icons, whichever you choose. A status bar along the bottom of
both windows shows what the current mode knows, plus the workspace and its
branch; clicking the branch opens Source Control. Closing a window hides it —
the app stays in the tray with every terminal still running, and the tray menu
shows a window, switches workspace or quits.

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
double-clicking it or dragging it to a new place makes it permanent.

**A layout you drag into shape.** Drag an editor tab along its strip, or into
another group's strip, and the tabs there move aside to show where it will land;
Escape puts it back. Drop it on a group's edge to split the area in that
direction, on its centre to move it there, and drag any divider to resize. Panels move the same way — onto any edge of any region, into another
region's tab strip, or onto the centre of the working area, where the panel
becomes a tab beside your documents or diffs. A panel closed from its tab comes
back from the title row's *View* menu or its hotkey. Editor splits belong to the
workspace; panel placement belongs to the app, one layout per mode.

**Custom views.** A view is a named list of shortcuts into the workspace, shown
in the Editor's *Custom* panel. Send files and folders to it from *Explorer*
and they sit at its root whatever
their depth on disk, each folder expanding to its real children. Nothing is
copied and nothing is moved; deleting a view deletes the list.

**Paths an agent can read.** *Quote to AI* on any file or folder writes
`@path/from/the/workspace/root` into the document you are editing — one line
per file when several are selected. In the rendered view a cited image, audio
file or video on a line of its own is drawn in place. Anywhere else — in a
sentence, after a label, in a table cell — it is a chip, as every other cited
file is: click a chip to open the file, rest the pointer on an image chip to
preview the image, and a citation to a file that is not there is marked in
red. One setting decides
whether pasting and dropping write a citation or a markdown link relative to the
note.

**Paste images and audio straight in.** They land in the project's clipboard
folder, get a link, and render inline — images shown, audio playable, without
leaving the document.

**Typing helpers.** Several cursors, column selection, moving and copying lines,
line comments, bracket pairs that wrap a selection, `Tab` to nest a list item
and `Alt+C` to tick a task box. They work in every view of a document, the
rendered one included.

**Git, including worktrees.** Source Control mode has five panels: *Commit*
(conflicts, staged, changed and untracked files, stashes, and the commit box),
*History* (a graph of the branches with each commit's author, age and hash),
*Branches* (local and remote, with fetch, pull and push and git's full output),
*Worktrees* and *Tags*. Diffs open side by side or inline in its working area,
with hunk staging; blame stays in the Editor. Worktrees matter because a project
here is often *itself* a worktree of another one — and creating one offers to
open it as a new workspace, while removing one offers to delete its branch and
says how many commits only that branch holds. In the switcher and the tray a
worktree sits under its repository; drag a repository's row to reorder the
list, and its worktrees move with it.

**A key and an identity per workspace.** Settings → *Credentials* lists the
SSH keys you add from `~/.ssh` and the commit identities you define; a
workspace's own page assigns one of each. Its fetches, pulls and pushes then
offer that key and no other — two accounts on one host never cross — and its
commits carry that name and email. A passphrase is kept in your desktop's
wallet (GNOME Keyring, KWallet or KeePassXC), never in a file of the app's; with
no wallet, it is not saved. A worktree with nothing assigned uses its
repository's key and identity. Your terminals keep your own ssh setup unless
you turn on *Terminals use this workspace's credentials* for that workspace,
and then only inside its repository. An unknown host key, a passphrase or a
server's question from git or from ssh in a terminal comes up as a dialog in
the window that asked.

**Change marks.** Lines that differ from git's index are marked in the gutter
of the source view — added, changed, and a wedge where lines were deleted — and
over the scrollbar of every view, where clicking a mark scrolls to it.

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
  rustup nodejs pnpm git openssh ripgrep glib2 libnotify
```

`src-tauri/Cargo.toml` sets the Rust floor at 1.88; `rustup default stable`
meets it.

> **Fish users:** `~/.cargo/env` is bash syntax and errors under fish. Use
> `source ~/.cargo/env.fish`, or persist it with `fish_add_path ~/.cargo/bin`.

```bash
pnpm install
pnpm tauri dev          # development: both windows, hot reload, its own identity and state
pnpm release            # deb / rpm / AppImage under src-tauri/target/release/bundle/
cd src-tauri && cargo test --lib     # unit tests; no compositor or PTY needed
```

`lore codex show operations-running-agentic-workspace` carries the rest:
what each package is linked against, where the app keeps its state, how to
install an AppImage and replace it with a newer build, why `pnpm tauri dev` runs
beside an installed build instead of colliding with it, how to start it at login
under KDE, and the four failures that stop it before a window appears.

## Keys

| Key | Where | Does |
|---|---|---|
| `Ctrl+Shift+P` | both | Switch workspace |
| `Ctrl+Shift+Space` | both | Focus the other window |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | both | Editor / Source Control / Terminal mode |
| `Ctrl+Q` | both | Quit |
| `Ctrl+Alt+A` | anywhere | Raise the window you last used (bound through the desktop portal; reassign it in System Settings → Shortcuts) |
| `Ctrl+Shift+T` / `Ctrl+Shift+W` | terminal | New / close terminal tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | both | Next / previous tab |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | terminal | Copy / paste |
| `Ctrl+Shift+F` | terminal / workspace | Search the scrollback / the Search panel |
| `Ctrl+Shift+E` | workspace | The Explorer panel |
| `Ctrl+Shift+G` | workspace | The Commit panel, in Source Control |
| `Ctrl+Shift+O` | workspace | The Outline panel |
| `Ctrl+P` | workspace | Quick open a file |
| `Ctrl+S` / `Ctrl+W` | workspace | Save / close the tab |
| `Ctrl+E` | workspace | Cycle the markdown editor: source → split → rich |
| `Ctrl+\` / `Ctrl+Alt+\` | workspace | Split the working area / move the tab to the next group |
| `Ctrl+,` | both | Settings |
| `Ctrl+Alt+Shift+C` | workspace | Copy the selected path, relative to the workspace |
| `Ctrl+Z` | Explorer | Undo the last move made by dragging or by cut and paste |
| `Ctrl` while dropping | Explorer | Copy the dragged files instead of moving them |

A panel hotkey selects and focuses that panel wherever you have docked it,
switches to its mode, and brings it back if you closed it.

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

In rich mode, and on the rendered side of a split, a toolbar under the
breadcrumb sets the paragraph style (body text, heading 1, 2 or 3) and applies
bold, italic, strikethrough, inline code, a link, a bulleted or numbered list,
a checklist, a quote or a code block. Each control shows whether the selection
already has its formatting, and its tooltip names its key:

| Key | Does |
|---|---|
| `Ctrl+B` / `Ctrl+I` | Bold / italic the selection or the word at the caret; again, take it off |
| `Ctrl+Shift+X` / `` Ctrl+` `` | Strikethrough / inline code |
| `Ctrl+K` | Link the selection, or edit the link at the caret: its text, its target, or *Remove link* |
| `Ctrl+Alt+1` / `Ctrl+Alt+2` / `Ctrl+Alt+3` | Heading 1 / 2 / 3 |
| `Ctrl+Alt+0` | Body text |
| `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` | Bulleted list / numbered list / checklist, on each selected line; again, plain text |
| `Backspace` at the start of a heading, item or quote | Plain paragraph; a second press joins it to the paragraph above |

The keys go by their place on the keyboard, so they sit in the same place on
any layout. With the caret between words, a character format applies to what
you type next. Each command writes the Markdown for its formatting — `**`, `*`,
`~~`, backticks, `#`, `-`, `1.`, `- [ ]`, `>` or a fence — and only the few
bytes that Markdown needs to read as meant, such as a backslash before a stray
`*` or a blank line before the next list item. It never changes the text you
see anywhere else, and one `Ctrl+Z` takes it back. A command that Markdown
would read otherwise does nothing, and in code, frontmatter or a source box
the formatting commands and `Ctrl+K` do nothing. Copying from rich mode puts
the Markdown on the clipboard as text, for an agent's prompt, and the formatting
as HTML, for a word processor or an email.

The rendered markdown view never shows the Markdown: the caret moves over text,
one arrow press per visible character, and steps over an image, a chip or a
rule in one press. Enter starts a new paragraph and `Shift+Enter` breaks the
line inside one; typing `# `, `- `, `**word**` or three backticks and Enter
formats as you go. A code block keeps its language as a small label you can
change, and what the view does not draw — an HTML block, a footnote — shows its
source in a box of its own. `Ctrl`+click follows a link. Paste an image or drop a file
onto a document and it lands in the workspace's clipboard folder; Settings →
*Asset links* decides whether the document gets a markdown link relative to the
note or an `@` citation from the workspace root.

Themes: four built in, and Settings → Import… reads a VS Code theme from a
`.json` or a `.vsix`, reporting what it could not map. A theme can be set per
workspace so projects are distinguishable at a glance.

Git runs through the `git` binary on your machine, so hooks run and your
configuration applies — except where a workspace has an SSH key or a commit
identity assigned: its remote operations offer that key alone, and its
commits take that name and email over your configuration's. Desktop
notifications go through `notify-send`; clicking one switches to the terminal
that went quiet.

`Ctrl`+click a path or URL printed in a terminal to open the file at that line
in the Workspace window, or the URL in your browser. The ✎ button in the title
row renames a workspace; the path underneath does not change.

Double-click a terminal tab to rename it; drag tabs to reorder them; right-click
one to restart its shell. Right-click in the file tree for file operations, for
*Quote to AI*, for *Send to* a view, and on a folder for *Open terminal here*;
deleting moves to the trash through GIO.

Drag files and folders in the Explorer onto a folder to move them; a name
already taken asks whether to replace it, keep both or cancel. Drop files from
your file manager onto a folder to copy them in, drag a single file out to
another application, or drop an entry on the middle of a Markdown document to
write a link or an `@` citation to it where it lands.

Settings open as a column of pages — General, Editor, Terminal, Panels, Agent
signals, Credentials, and one for the active workspace — and reopen on the page
you left. Click a breadcrumb above a document to copy its path, relative to the
workspace (the workspace crumb copies the absolute path); right-click it to
reveal it in the Explorer or copy its absolute path. In a narrow editor group
the Source, Split and Rich buttons keep their place at the right and the
breadcrumb gives way: the heading trail shortens and then goes, the folders and
then the workspace fold into one `…` crumb whose menu lists them, and last the
file name shortens. A shortened crumb shows its full text in its tooltip.
