# Agentic Workspace — Acceptance Criteria

Status: draft · greenfield · 2026-09-22

Every criterion is written as Given / When / Then, grouped by the part of the
product it defines. Each carries an id and a priority:

| Priority | Meaning |
|---|---|
| **P0** | The product does not exist without it. First milestone. |
| **P1** | The product is unpleasant without it. Second milestone. |
| **P2** | Wanted, deliberately deferred. |

Decisions already settled with the product owner are recorded in
[§14 Settled decisions](#14-settled-decisions). Gaps filled in by assumption —
correct these first — are in [§15 Assumptions](#15-assumptions-filled-in).
Platform constraints inherited from `local-transcribe` are in
[§13 Platform](#13-platform--arch--kde--wayland).

---

## 1. Workspaces and switching

The core mechanism. A **workspace** is exactly one directory. Everything else —
editor tabs, terminal tabs, file tree state, git context — hangs off it.

### WS-01 — Add a workspace · P0
- **Given** no workspace exists for `~/projects/foo`
- **When** I choose *Add folder…* and select `~/projects/foo`
- **Then** a workspace named `foo` appears in the switcher, becomes active, and opens with its file tree rooted at that directory, no editor tabs, and one terminal tab whose working directory is `~/projects/foo`

### WS-02 — Switch workspace by selector · P0
- **Given** workspaces `foo` (active) and `bar` both exist, and `foo` has 2 editor tabs and 3 terminal tabs open
- **When** I pick `bar` in the switcher
- **Then** both windows swap to `bar`'s file tree, editor tabs and terminal tabs within 150 ms, and `foo`'s tabs are no longer visible in either window

### WS-03 — Switch workspace by hotkey · P0
- **Given** the app has focus and more than one workspace exists
- **When** I press the workspace-switch hotkey
- **Then** a quick-switch overlay opens listing workspaces most-recently-used first, filterable by typing, and Enter switches to the highlighted one

### WS-04 — Background processes survive a switch · P0
- **Given** workspace `foo` has a terminal running `pnpm dev` and another running `claude`
- **When** I switch to `bar`, work there for ten minutes, and switch back to `foo`
- **Then** both processes are still the same PIDs, still running, and the terminals show everything they printed while I was away, scrolled to the bottom

### WS-05 — Output while detached is not lost · P0
- **Given** workspace `foo` is in the background and its terminal prints 4 000 lines
- **When** I switch back to `foo`
- **Then** the terminal shows those lines in order, subject to the scrollback limit, with no interleaving or corruption

### WS-06 — Detached terminals do not thrash the UI · P1
- **Given** a background workspace's terminal is printing continuously
- **When** I am working in a different workspace
- **Then** the app does not render that output, and CPU use attributable to the background terminal stays proportional to reading and buffering its bytes, not to drawing them

### WS-07 — Terminal size follows the visible window · P1
- **Given** workspace `foo` was detached at 120×40 and I resize the Terminal window while `bar` is active
- **When** I switch back to `foo`
- **Then** `foo`'s PTYs are resized to the new dimensions, the running programs receive `SIGWINCH`, and a full-screen program such as `claude` or `tmux` redraws correctly

### WS-08 — Remove a workspace · P1
- **Given** workspace `bar` exists with running terminals and unsaved editor buffers
- **When** I remove it from the switcher
- **Then** I am warned about the unsaved buffers and the running processes by name, and on confirmation its processes are terminated and its saved state is discarded — but no file on disk is deleted

### WS-09 — Missing directory · P1
- **Given** workspace `bar` points at a directory that has since been deleted or unmounted
- **When** the app starts or I switch to `bar`
- **Then** the workspace is shown as unavailable with the path it expected, nothing is auto-created, and I am offered *Locate…* and *Remove*

### WS-10 — Rename a workspace · P2
- **Given** two workspaces whose directories are both named `docs`
- **When** I rename one to `docs (client)`
- **Then** the switcher shows the new label everywhere while the underlying path is unchanged

---

## 2. Windows and layout

Two real OS windows: **Workspace** (tree + editor) and **Terminal**. Both show
the same active workspace at all times.

### WIN-01 — Two independent windows · P0
- **Given** the app is running
- **Then** there are exactly two windows — Workspace and Terminal — each with its own entry in the task bar and its own icon, each independently movable, resizable and assignable to a monitor or virtual desktop by the compositor

### WIN-02 — Both windows follow the active workspace · P0
- **Given** the Workspace window shows `foo` and the Terminal window shows `foo`'s terminals
- **When** I switch to `bar` from *either* window
- **Then** both windows switch together; they can never show different workspaces

### WIN-03 — Raise the other window, in-app · P0
- **Given** the Terminal window has focus
- **When** I press the "focus other window" hotkey
- **Then** the Workspace window is raised and focused, and pressing it again returns focus to the Terminal window

### WIN-04 — Raise the app from anywhere · P1
- **Given** the app is running and a different application has focus
- **When** I press the globally-registered hotkey
- **Then** the most recently focused of the two windows is raised and focused (see PLT-02 for how this is bound under Wayland)

### WIN-05 — Closing one window does not end the app · P0
- **Given** both windows are open with processes running
- **When** I close the Terminal window
- **Then** the app keeps running, every PTY keeps running, the Workspace window is unaffected, and reopening the Terminal window shows the same terminal tabs still live

### WIN-06 — Quitting · P0
- **Given** terminals are running and buffers are unsaved
- **When** I quit the app
- **Then** I am prompted about unsaved buffers, and on confirmation every PTY in every workspace is sent `SIGHUP` and reaped before the process exits — no orphaned shells are left behind

### WIN-07 — Geometry is remembered per window · P1
- **Given** I sized and placed both windows to my liking and quit
- **When** I launch the app again
- **Then** each window reopens at its last size, and at its last position where the session permits it (see PLT-03)

### WIN-08 — Single instance · P1
- **Given** the app is already running
- **When** I launch it again from the menu or a terminal
- **Then** no second instance starts; the existing windows are raised instead

---

## 3. Terminal

A real terminal, good enough to host `claude`, `tmux`, `vim` and a dev server.

### TERM-01 — Spawn a shell · P0
- **Given** workspace `foo` is active
- **When** I open a new terminal tab
- **Then** a PTY is allocated and my login shell (from `$SHELL`) starts in `~/projects/foo` with the workspace's environment, and the prompt appears

### TERM-02 — Full-fidelity emulation · P0
- **Given** a terminal tab is open
- **When** I run a full-screen TUI — `claude`, `tmux`, `htop`, `vim`
- **Then** it renders correctly: alternate screen buffer, cursor shapes, 256-colour and 24-bit colour, mouse reporting, bracketed paste, and resize handling all behave as they do in Konsole

### TERM-03 — Tabs · P0
- **Given** workspace `foo` is active
- **When** I open, close, rename and reorder terminal tabs
- **Then** each tab is an independent PTY, tabs belong to `foo` alone, and closing a tab sends `SIGHUP` to its process group

### TERM-04 — Tab titles track what is running · P1
- **Given** a terminal tab I have not named myself
- **When** the running program emits an OSC 0/2 title sequence, or the foreground process changes
- **Then** the tab label reflects it — `claude`, `pnpm dev`, or the basename of the cwd when the shell is idle

### TERM-05 — A named tab stays named · P1
- **Given** I renamed a tab to `server`
- **When** the program inside changes its title
- **Then** the tab still reads `server`

### TERM-06 — Scrollback · P0
- **Given** a terminal has produced more output than fits the window
- **When** I scroll up, or search the scrollback
- **Then** at least 10 000 lines per tab are retained and searchable, and new output while scrolled up does not yank me to the bottom

### TERM-07 — Copy and paste · P0
- **Given** text is selected in a terminal
- **When** I copy it and paste into the editor, or paste from the system clipboard into the terminal
- **Then** the text transfers intact, multi-line pastes use bracketed paste where the program supports it, and the primary selection works as it does elsewhere on KDE

### TERM-08 — Working directory is tracked · P0
- **Given** a terminal tab started in `~/projects/foo` and I `cd` into `~/projects/foo/src`
- **When** the app records session state
- **Then** the tab's recorded working directory is `~/projects/foo/src` (read from `/proc/<pid>/cwd` of the shell, so it needs no shell integration)

### TERM-09 — Terminal font and size · P1
- **Given** I open settings
- **When** I change the terminal font family, size or line height
- **Then** every open terminal reflows immediately and the setting persists

### TERM-10 — Clickable paths · P2
- **Given** a program prints `src/lib.rs:42:7` or a URL
- **When** I ctrl-click it
- **Then** a file path opens in the editor at that line in the current workspace, and a URL opens in the default browser

---

## 4. File tree

### TREE-01 — Tree rooted at the workspace · P0
- **Given** workspace `foo` is active
- **When** the Workspace window is shown
- **Then** a file tree rooted at `~/projects/foo` is displayed, directories are expandable, and expansion state persists per workspace across a switch and across a restart

### TREE-02 — Open a file · P0
- **Given** the tree is showing `readme.md`
- **When** I click it
- **Then** it opens in an editor tab; clicking it again focuses the existing tab rather than opening a duplicate

### TREE-03 — File operations · P1
- **Given** a file or folder in the tree
- **When** I use the context menu
- **Then** I can create, rename, duplicate, delete (to trash, not `rm`), copy the path, and reveal it in Dolphin

### TREE-04 — Tree reflects the filesystem · P0
- **Given** the tree is visible and an agent creates, deletes or renames files in the workspace
- **When** the change lands on disk
- **Then** the tree updates within a second without me refreshing it

### TREE-05 — Ignored files are dimmed, not hidden · P0
- **Given** a workspace containing `.lore/`, `.gitignore`, `node_modules/` and `target/`
- **When** the tree renders
- **Then** ignored paths are **shown, dimmed** — present and openable, visibly lower-contrast than tracked files, as in VSCodium — and an ignored folder dims its whole subtree

### TREE-05a — Dotfiles are shown · P0
- **Given** a workspace containing `.lore/`, `.claude/`, `.gitignore` and `.env`
- **When** the tree renders
- **Then** every one of them is visible without a toggle; this product's projects keep their real content in dotfolders, so hiding them by default would hide the work

### TREE-05b — `.git/` alone is hidden · P1
- **Given** a workspace that is a git repository
- **When** the tree renders
- **Then** `.git/` is the one exception — hidden by default because its contents are machine state rather than project content — and a *Show `.git`* toggle reveals it

### TREE-05c — Dimming survives nested ignore files · P1
- **Given** a `.gitignore` at the project root and another inside `docs/`, plus a negated pattern (`!keep.log`)
- **When** the tree renders
- **Then** dimming matches what git itself would ignore — nested ignore files, negation and `.git/info/exclude` all respected — so the tree never disagrees with `git status`

### TREE-05d — Copy path · P0
- **Given** a file or folder selected in the tree, or an editor tab with focus
- **When** I press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>, or choose *Copy relative path* from the context menu
- **Then** the path **relative to the workspace root**, with forward slashes and no leading `./`, is on the clipboard — ready to paste into an agent prompt
- **And when** I choose *Copy absolute path* from the same menu
- **Then** the full path is copied instead

### TREE-05e — Copy path for a multiple selection · P2
- **Given** several files selected in the tree
- **When** I copy the relative path
- **Then** one path per line is copied, in tree order

### TREE-06 — Filter the tree · P1
- **Given** a large tree
- **When** I type in the tree's filter box
- **Then** only matching paths and their ancestors remain visible, and clearing the box restores the previous expansion state

### TREE-07 — Quick open · P0
- **Given** workspace `foo` is active
- **When** I press the quick-open hotkey and type part of a filename
- **Then** fuzzy-matched files from the workspace are listed most-recently-used first and Enter opens the highlighted one

### TREE-08 — Project-wide search · P1
- **Given** workspace `foo` is active
- **When** I search for a string across the project
- **Then** results appear grouped by file with line numbers and context, ignored paths excluded by default with a toggle to include them (dimming is a tree affordance; search is about signal), and clicking a result opens that file at that line

### TREE-09 — Large and ignored directories stay cheap · P0
- **Given** an ignored `node_modules/` holding 40 000 files, shown dimmed under TREE-05
- **When** the tree renders and I expand it
- **Then** directory contents are read lazily on expansion rather than up front, a directory above a size threshold pages or virtualises rather than rendering every row, and no file watch is placed on an ignored subtree (ED-23)

---

## 5. Editor — modes

Three modes, per the settled decision. The differentiator is that in split mode
**both sides are editable**.

### ED-01 — Source mode · P0
- **Given** `readme.md` is open in source mode
- **When** I look at it
- **Then** I see the raw markdown with syntax highlighting, line numbers and breadcrumbs, and editing it is plain text editing — no transformation of any kind

### ED-02 — Split mode, rendered side editable · P0
- **Given** `readme.md` is open in split mode with source on the left and the rendered document on the right
- **When** I place the cursor in the rendered side and type
- **Then** I am editing, not previewing: the text changes in place, the left side updates to match, and the file on disk is written per ED-07

### ED-03 — Rich mode · P0
- **Given** `readme.md` is open
- **When** I switch to rich mode
- **Then** the rendered document fills the tab with no source pane, and it is fully editable — a WYSIWYG markdown editor, not a preview

### ED-04 — Cycling modes · P0
- **Given** a markdown file is open in any mode
- **When** I press the mode hotkey
- **Then** it cycles source → split → rich → source, the mode is remembered per file, and the cursor position is preserved across the change where the two representations correspond

### ED-05 — Live sync, left to right · P0
- **Given** split mode is open
- **When** I type in the source pane
- **Then** the rendered pane updates within 100 ms for a document of 2 000 lines, without losing my scroll position

### ED-06 — Scroll sync · P1
- **Given** split mode is open on a long document
- **When** I scroll either pane
- **Then** the other follows, aligned by block, and the alignment survives blocks of very different rendered height such as tables and code fences

### ED-07 — Only what I edited is rewritten · P0
- **Given** `rite-design.md` contains `*` bullets, `_emphasis_`, hand-wrapped prose and a YAML frontmatter block
- **When** I change one word in one paragraph from the rendered pane and save
- **Then** exactly that paragraph's byte range is rewritten and every other byte in the file is unchanged — bullet characters, emphasis characters, wrap points and blank lines all preserved

### ED-08 — Edits spanning blocks · P0
- **Given** split mode and two adjacent paragraphs
- **When** I delete the blank line between them from the rendered pane, merging them
- **Then** the smallest enclosing source range covering both blocks is rewritten, and no byte outside that range changes

### ED-09 — Unrepresentable edits are refused, not mangled · P1
- **Given** the rendered pane shows a construct the serializer cannot round-trip faithfully
- **When** I attempt to edit it there
- **Then** the app tells me so and points me at source mode, rather than writing something different from what I meant

### ED-10 — Frontmatter as a table · P1
- **Given** a markdown file opening with a `---` YAML frontmatter block
- **When** it is rendered in split or rich mode
- **Then** the frontmatter appears as a key/value table, editing a value rewrites only that YAML line, and keys whose value is a list or block scalar remain editable as text

### ED-11 — Markdown constructs · P0
- **Given** documents in this repo's style
- **When** they are rendered
- **Then** headings, bold, italic, inline code, fenced code with language highlighting, links, images, blockquotes, ordered/unordered/task lists, tables, horizontal rules and footnotes all render correctly, and mermaid fences render as diagrams (P2)

### ED-12 — Editor tabs · P0
- **Given** workspace `foo` is active
- **When** I open several files
- **Then** each is a tab, tabs are reorderable and closable, tabs belong to `foo` alone, and an unsaved tab is marked

### ED-12a — Split the editor area · P1
- **Given** `acceptance-criteria.md` is open
- **When** I split the editor area
- **Then** a second editor group appears beside the first, each group has its own tab strip and its own active tab, and I can view two files — or two views of the same file — at once

### ED-12b — Move tabs between groups · P1
- **Given** two editor groups
- **When** I drag a tab from one to the other, or use the move-group hotkey
- **Then** the tab moves with its scroll position, editor mode and undo history intact, and a group left with no tabs closes itself

### ED-12c — Groups are part of the workspace · P1
- **Given** workspace `foo` has two editor groups and `bar` has one
- **When** I switch between them
- **Then** each workspace restores its own group layout and split ratio, and the layout survives a restart (PER-02)

### ED-25 — Breadcrumbs carry the heading trail · P1
- **Given** a markdown file open with the cursor inside a subsection
- **When** I look at the breadcrumb bar
- **Then** it reads the path from the workspace root followed by the heading trail to the cursor — `docs › acceptance-criteria.md › # Agentic Workspace › ## 12. Persistence` — each segment clickable to jump

### ED-26 — Outline · P1
- **Given** a long markdown file
- **When** I open the outline panel
- **Then** its headings are listed as a nested tree, the heading containing the cursor is highlighted as I scroll, and clicking one scrolls to it

### ED-27 — Minimap · P2
- **Given** a file longer than the viewport
- **When** the minimap is enabled
- **Then** a condensed overview of the whole file is drawn at the edge, the viewport region is marked, clicking or dragging scrolls the document, and it can be switched off

### ED-28 — Status bar · P1
- **Given** a file open in the editor
- **When** I look at the status bar
- **Then** it shows the git branch, the cursor's line and column, the indentation setting, the character encoding, the line-ending style and the detected language — and clicking the language opens the picker from ED-17c

### ED-13 — Save · P0
- **Given** a modified buffer
- **When** I press the save hotkey
- **Then** the file is written atomically (write to a temp file in the same directory, then rename), the modified marker clears, and file mode and ownership are preserved

### ED-14 — Autosave · P1
- **Given** autosave is enabled
- **When** I stop typing for the configured delay, or the editor loses focus
- **Then** the buffer is saved under the same guarantees as ED-13

### ED-15 — Unsaved work survives a crash · P1
- **Given** I have unsaved changes and the app is killed
- **When** I launch it again
- **Then** the buffer is restored with my changes and marked unsaved, with the on-disk file untouched

### ED-16 — Undo · P0
- **Given** I have made edits across modes — some in source, some in the rendered pane
- **When** I undo repeatedly
- **Then** the document walks back through those edits in order, regardless of which pane each was made in

---

## 6. Editor — clipboard assets

### AST-01 — Paste an image · P0
- **Given** `notes.md` is open and an image is on the clipboard
- **When** I paste into the editor
- **Then** the image is written into the workspace's configured clipboard folder (default `clipboard/`, created if absent), a relative markdown image link is inserted at the cursor, and the image renders inline in split and rich mode

### AST-02 — Paste audio · P0
- **Given** an audio file is on the clipboard or dragged into the editor
- **When** it is inserted
- **Then** it is stored the same way and rendered inline as a playback control with play/pause, a seek bar and a duration — playable without leaving the editor

### AST-03 — Naming · P0
- **Given** an asset is being stored
- **When** the source has a filename (a dropped or copied file)
- **Then** that filename is kept, and a collision appends `-2`, `-3`, …
- **And when** the source has no filename (a raw clipboard bitmap)
- **Then** it is named by paste time, e.g. `2026-09-22-113045.png`

### AST-04 — Destination is configurable per workspace · P0
- **Given** workspace `foo` stores assets in `clipboard/` and workspace `bar` should use `docs/media/`
- **When** I change `bar`'s clipboard folder in settings
- **Then** subsequent pastes in `bar` land in `docs/media/`, `foo` is unaffected, existing links are not rewritten, and the setting is stored centrally rather than in the repo

### AST-05 — Links are relative to the note · P0
- **Given** `docs/deep/note.md` is open and the clipboard folder is `clipboard/` at the project root
- **When** I paste an image
- **Then** the inserted link is relative to the note — `../../clipboard/foo.png` — so the document renders correctly anywhere that resolves relative links, including GitHub

### AST-06 — Video and other files · P1
- **Given** a file that is neither an image nor audio is dropped in
- **When** it is inserted
- **Then** video renders as a player, and anything else is inserted as a plain link with its filename

### AST-07 — Large assets · P1
- **Given** a pasted asset is larger than the configured warning threshold
- **When** the paste happens
- **Then** the app tells me the size and where it went, so a 40 MB screenshot recording does not silently enter a git repository

### AST-08 — Broken links are visible · P1
- **Given** a document links an asset that no longer exists on disk
- **When** it renders
- **Then** a clear broken-asset placeholder showing the missing path is drawn, not a silent gap

### AST-09 — Drag out or reveal · P2
- **Given** an asset rendered in a document
- **When** I use its context menu
- **Then** I can reveal it in Dolphin, copy its path, open it in the system viewer, and replace it

---

## 7. Editor — non-markdown files and external changes

### ED-17 — Non-markdown files · P0
- **Given** I open `package.json`, `config.toml`, `index.html` or a file with no extension
- **When** it opens
- **Then** it opens in an editable tab with line numbers, bracket matching and find/replace — and **no** language server, autocomplete, diagnostics or go-to-definition

### ED-17a — The highlighted languages · P0
- **Given** the first milestone's grammar set
- **When** I open a file
- **Then** these are highlighted: **markdown**, **HTML**, **JSON**, **TOML**, **YAML** (`.yaml` and `.yml`)
- **And** markdown fenced code blocks are highlighted with the same set, by their info string

### ED-17b — Everything else opens plainly · P0
- **Given** I open `src/lib.rs`, a shell script, or a file with no extension
- **When** it opens
- **Then** it is fully editable as plain monospace text with no highlighting, no warning and no error — an unknown language is an ordinary case, not a failure

### ED-17c — Language can be set per tab · P1
- **Given** a file whose extension does not name its language — a `.conf` that is really TOML, or a file with no extension that is really YAML
- **When** I pick a language from the status bar
- **Then** the buffer is re-highlighted with that grammar, and the choice is remembered for that path

### ED-17d — Grammar importer · P2
- **Given** a language outside the built-in set
- **When** the importer lands
- **Then** a TextMate grammar — standalone or from a VSCode extension `.vsix` — can be imported, is validated before it is accepted, takes part in the theme scope mapping (THM-06) like a built-in grammar, and cannot hang the editor on a pathological pattern

### ED-18 — Mode switching does not apply to them · P0
- **Given** a non-markdown file is open
- **When** I press the mode hotkey
- **Then** nothing happens — split and rich modes are markdown-only

### ED-19 — Binary files · P1
- **Given** I open a file whose contents are binary
- **When** it opens
- **Then** the app says so and offers to open it externally, rather than rendering mojibake or attempting to edit it

### ED-20 — An agent changed a file I have open, unmodified · P0
- **Given** `readme.md` is open with no unsaved changes and `claude` rewrites it on disk
- **When** the change lands
- **Then** the buffer reloads within a second, keeping my scroll position and cursor line where they still exist, and a brief unobtrusive marker notes that it reloaded

### ED-21 — An agent changed a file I have open, modified · P0
- **Given** `readme.md` is open **with** unsaved changes and an agent rewrites it on disk
- **When** the change lands
- **Then** the buffer is **not** silently replaced; I am shown the conflict with a diff and offered *Keep mine*, *Take theirs* and *Open both*, and my unsaved work is never discarded without an explicit choice

### ED-22 — A file I have open was deleted · P1
- **Given** `notes.md` is open and it is deleted or moved on disk
- **When** the change lands
- **Then** the tab stays open with its label struck through, is marked as detached from disk, and saving it offers to recreate the file at that path

### ED-24 — Render an HTML file · P2
- **Given** `index.html` is open in the editor
- **When** I switch on HTML preview
- **Then** the file is rendered as a browser would render it, side by side with its source, resolving its relative CSS, script and image references from disk, and re-rendering as I edit
- **And** the preview runs isolated from the application — its own webview, its own origin, no access to the app's own APIs — so previewing a page cannot reach the workspace or the app itself

### ED-23 — Watching is bounded · P1
- **Given** a workspace containing `node_modules/` and `target/`
- **When** file watches are established
- **Then** ignored directories are excluded, and hitting the inotify watch limit degrades to a coarser strategy with a warning rather than failing silently

---

## 8. Git — status, diff, history, blame

All operations act on the active workspace's repository.

### GIT-01 — Non-repository workspaces · P0
- **Given** the active workspace is not inside a git repository
- **When** I open the git panel
- **Then** it says so plainly and offers *Initialise repository*, and nothing elsewhere in the UI misbehaves

### GIT-02 — Status · P0
- **Given** the workspace has modified, staged, untracked and deleted files
- **When** I open the git panel
- **Then** each is listed under the right heading with its path and status letter, and the list updates within a second of a change on disk — including changes an agent makes in the terminal

### GIT-03 — File decorations · P1
- **Given** files with git status
- **When** I look at the file tree and editor tabs
- **Then** modified, added, untracked, ignored and conflicted files are colour-coded consistently, and a folder shows a summary indicator for its contents

### GIT-04 — Diff a file · P0
- **Given** a modified file
- **When** I click it in the git panel
- **Then** a diff against the index (or against HEAD for a staged file) opens, with syntax highlighting, and I can switch between side-by-side and inline

### GIT-05 — Stage and unstage whole files · P0
- **Given** modified and untracked files
- **When** I stage or unstage one, several, or all
- **Then** the index is updated and the panel reflects it immediately

### GIT-06 — Stage hunks · P1
- **Given** a file with several separate changes
- **When** I stage one hunk from the diff view
- **Then** only that hunk enters the index, the file appears under both staged and modified, and the rest of the file is untouched

### GIT-07 — Commit · P0
- **Given** staged changes and a message typed into the message box
- **When** I commit
- **Then** the commit is created with my configured `user.name`/`user.email`, hooks run and a hook's failure is surfaced with its output, the message box clears, and the new commit is at the top of the history

### GIT-08 — Amend · P1
- **Given** a commit that is not yet pushed
- **When** I choose *Amend last commit*
- **Then** the message box is pre-filled with the previous message and committing rewrites that commit rather than adding one

### GIT-09 — History · P0
- **Given** a repository with commits
- **When** I open the history view
- **Then** commits are listed newest first with short hash, subject, author and relative date, the list pages as I scroll, and I can filter by file path

### GIT-10 — Inspect a commit · P0
- **Given** the history list
- **When** I select a commit
- **Then** its full message, metadata and the list of files it touched are shown, and selecting a file shows that commit's diff for it

### GIT-11 — Blame · P1
- **Given** a file open in the editor
- **When** I turn blame on
- **Then** each line is annotated with its last commit's short hash, author and relative date, clicking an annotation opens that commit, and the annotations track the buffer as I scroll

### GIT-12 — Discard changes · P1
- **Given** a modified file
- **When** I choose to discard its changes
- **Then** I am warned that this is not undoable, and on confirmation the file is restored from the index and any editor buffer showing it reloads

### GIT-13 — Conflicts are legible · P2
- **Given** the repository is mid-merge or mid-rebase with conflicts
- **When** I open the git panel
- **Then** the state is named, conflicted files are listed separately, and opening one shows the conflict markers with *Take ours* / *Take theirs* / *Take both* actions per hunk

---

## 9. Git — branches and worktrees

This group is the one that closes the loop with §1: a worktree is a candidate
workspace, and creating one should not require the terminal.

### BR-01 — Current branch is always visible · P0
- **Given** a workspace inside a repository
- **When** I look at either window
- **Then** the current branch name is shown, along with a detached-HEAD or mid-rebase state when that applies, and it updates when the branch changes by any means including the terminal

### BR-02 — List branches · P0
- **Given** a repository with local and remote-tracking branches
- **When** I open the branch list
- **Then** local branches are listed with their upstream and ahead/behind counts, remote branches are listed separately, and the list is filterable

### BR-03 — Create a branch · P0
- **Given** the branch list
- **When** I create a branch, choosing its start point
- **Then** the branch is created and I am asked whether to switch to it, create a worktree for it, or neither

### BR-04 — Switch branch · P0
- **Given** a clean working tree
- **When** I switch branch
- **Then** the checkout happens, the file tree, open buffers and git panel all refresh, and any open buffer whose file changed is handled under ED-20/ED-21

### BR-05 — Switching with a dirty tree is refused safely · P0
- **Given** uncommitted changes that would be overwritten by the checkout
- **When** I attempt to switch
- **Then** git's refusal is surfaced in plain language naming the offending files, and I am offered *Stash and switch* or *Create a worktree instead* — nothing is force-checked-out

### BR-06 — Delete a branch · P1
- **Given** a branch that is not checked out anywhere
- **When** I delete it
- **Then** an unmerged branch requires an explicit force confirmation naming the commits that would be lost, and a branch checked out in a worktree is refused with that worktree named

### BR-07 — List worktrees · P0
- **Given** a repository with linked worktrees
- **When** I open the worktree list
- **Then** every worktree is listed with its path, branch and whether it is the main one, a prunable or locked worktree is flagged, and each row shows whether it is already open as a workspace

### BR-08 — Create a worktree · P0
- **Given** the worktree list
- **When** I create one, choosing a branch (existing or new) and a directory
- **Then** the worktree is created, and I am offered *Open as workspace* — accepting adds it under §1 named so its parent project and branch are both legible, e.g. `lore (wt: refactor)`

### BR-09 — A worktree workspace knows its origins · P1
- **Given** workspace `lore (wt: refactor)` is a worktree of `~/projects/lore`
- **When** I look at its git panel
- **Then** it is identified as a worktree, the main worktree's path is shown, and the branch, history and status are those of the worktree — not of the main checkout

### BR-10 — Delete a worktree · P0
- **Given** a worktree that is open as a workspace and has running terminals
- **When** I delete it
- **Then** I am warned that a workspace is open in it, told about the running processes and any uncommitted changes there, and on confirmation the processes are terminated, the workspace is removed, and `git worktree remove` runs — with the refusal surfaced rather than forced if git declines

### BR-11 — Prune worktrees · P1
- **Given** worktrees whose directories no longer exist
- **When** I prune
- **Then** the entries git would remove are listed for confirmation before `git worktree prune` runs

### BR-12 — Remotes · P2
- **Given** a branch with an upstream
- **When** I use the remote actions
- **Then** fetch, pull and push are available with their progress and their errors — including non-fast-forward rejections — surfaced in full, and authentication is delegated to the system git credential helper

---

## 10. Agent awareness

Two signals, both settled with the product owner, both switchable off.

### AGT-01 — Attention badge on the switcher · P0
- **Given** workspace `bar` is in the background and its terminal produces output, or rings the bell, after I last looked at it
- **When** I look at the switcher
- **Then** `bar` carries an attention badge, and the badge clears when I switch to `bar` and view the tab that raised it

### AGT-02 — Badge points at the tab · P1
- **Given** `bar` carries an attention badge raised by its second terminal tab
- **When** I switch to `bar`
- **Then** the tab that raised it is marked, so I do not have to check each one

### AGT-03 — Notify when a busy terminal goes quiet · P0
- **Given** a background terminal has been producing output and notifications are enabled
- **When** it produces nothing for the configured quiet threshold (default 20 s)
- **Then** a desktop notification names the workspace and the tab and says it has gone quiet, and activating the notification switches to that workspace and focuses that tab

### AGT-04 — No notification without preceding activity · P0
- **Given** a background terminal sitting at an idle shell prompt, which has produced no output since I left it
- **When** the quiet threshold elapses
- **Then** no notification is sent — quiet only counts as an event after a busy period

### AGT-05 — No notification for the workspace I am in · P0
- **Given** the active workspace's terminal goes quiet
- **When** the threshold elapses
- **Then** no notification is sent; I can already see it

### AGT-06 — Notifications are switchable · P0
- **Given** the settings screen
- **When** I turn notifications off
- **Then** no desktop notifications are sent by any workspace, the attention badges continue to work, and the setting persists
- **And given** a per-workspace override
- **When** I turn notifications off for `bar` alone
- **Then** `bar` sends none and every other workspace is unaffected

### AGT-07 — Quiet threshold is configurable · P1
- **Given** the settings screen
- **When** I change the quiet threshold
- **Then** the new value applies to subsequent detection, and a documented floor prevents a value so low that a slow build notifies constantly

### AGT-08 — Notifications do not pile up · P1
- **Given** a terminal that alternates between output and quiet
- **When** it crosses the threshold repeatedly
- **Then** at most one outstanding notification per tab exists at a time, replaced rather than stacked

### AGT-09 — Process-exit is distinguished from quiet · P2
- **Given** a background terminal whose foreground process exits
- **When** the app detects it
- **Then** the notification says the process finished and reports its exit status, rather than merely reporting quiet

---

## 11. Themes and appearance

### THM-01 — Built-in themes · P0
- **Given** the settings screen
- **When** I open the theme picker
- **Then** at least four hand-tuned themes are offered, covering dark and light, and selecting one restyles the editor, file tree, terminal, git panel and chrome of both windows immediately with no restart

### THM-02 — One theme, everywhere · P0
- **Given** a theme is active
- **When** I look at either window
- **Then** both windows and every panel use it consistently — there is no unstyled corner

### THM-03 — Terminal colours come from the theme · P0
- **Given** a theme is active
- **When** a program emits ANSI colours
- **Then** the terminal's 16 ANSI colours, background, foreground, cursor and selection all come from that theme

### THM-04 — Import a VSCode theme · P1
- **Given** a VSCode or VSCodium colour theme as a `.json` or a `.vsix`
- **When** I import it
- **Then** it is parsed — including JSONC comments and `include` chains, and reaching inside a `.vsix` archive — added to the picker under its own name, and selectable like a built-in

### THM-05 — UI colours map exactly · P1
- **Given** an imported theme
- **When** it is applied
- **Then** its `colors` keys map directly onto the corresponding surfaces — editor background, gutter, selection, sidebar, tabs, panel borders, terminal ANSI palette — so the result is visually recognisable as that theme

### THM-06 — Token colours map through an adapter · P1
- **Given** an imported theme's `tokenColors` TextMate scopes
- **When** a file is highlighted
- **Then** scopes are translated to the editor's highlight tags through a documented mapping table, most-specific scope winning, and `semanticTokenColors` is ignored rather than misapplied

### THM-07 — Unmappable scopes are reported, not hidden · P1
- **Given** an imported theme using scopes outside the mapping table
- **When** the import completes
- **Then** I am shown a plain summary of what could not be translated and what it fell back to — so an odd-looking result is explainable rather than a mystery

### THM-08 — A bad theme file cannot break the app · P0
- **Given** a malformed, truncated or hostile theme file
- **When** I import it
- **Then** the import fails with a clear message, the active theme is untouched, and the app keeps running

### THM-09 — Remove an imported theme · P1
- **Given** an imported theme
- **When** I remove it
- **Then** it leaves the picker, and if it was active the app falls back to a built-in

### THM-10 — Per-workspace theme override · P2
- **Given** several workspaces
- **When** I set a theme for one of them
- **Then** switching to it changes the theme, so projects are distinguishable at a glance, and workspaces with no override use the global theme

### THM-11 — Editor font · P1
- **Given** the settings screen
- **When** I set the editor font family and size, separately from the terminal's
- **Then** source mode uses it as a monospace face, rich and split rendering use proportional text for prose and the monospace face for code, and both persist

---

## 12. Persistence and session restore

Settled: terminal tabs come back with their working directory and a **fresh**
shell. No scrollback is persisted; no command is re-run automatically.

### PER-01 — Session state is durable · P0
- **Given** workspaces with open editor tabs and terminal tabs
- **When** state changes
- **Then** it is written to the app's own store under `~/.local/share/<app-id>/`, and nothing is written inside any project directory

### PER-02 — Restore on launch · P0
- **Given** I quit yesterday with three workspaces, each holding editor tabs and terminal tabs
- **When** I launch the app today
- **Then** every workspace is listed, the last active one is restored with its editor tabs reopened at their previous scroll position and editor mode, its file tree expansion intact, and its terminal tabs present with their names and working directories

### PER-03 — Restored terminals are fresh shells · P0
- **Given** a restored terminal tab that was running `pnpm dev` yesterday
- **When** I switch to it
- **Then** it holds a new shell whose working directory is the one recorded, showing a clean prompt — nothing was re-run, and no prior output is replayed

### PER-04 — Background workspaces restore lazily · P1
- **Given** eight workspaces were open when I quit
- **When** I launch the app
- **Then** the active one is restored immediately and the others are restored when first switched to, so launch time does not scale with how many projects I keep

### PER-05 — A corrupt state store does not brick the app · P0
- **Given** the state store is corrupt or was written by a newer version
- **When** the app launches
- **Then** it starts with an empty workspace list, says what happened, and moves the unreadable store aside rather than deleting it

### PER-06 — Settings persist · P0
- **Given** any setting — theme, fonts, notification toggles and threshold, autosave, per-workspace clipboard folder
- **When** I change it and relaunch
- **Then** it is still in effect

### PER-07 — Crash does not lose the session · P1
- **Given** the app is killed rather than quit
- **When** I relaunch
- **Then** the last committed session state is restored under PER-02, and unsaved buffers are restored under ED-15

---

## 13. Platform — Arch / KDE / Wayland

Inherited from `local-transcribe`, where each of these cost real debugging time.
They are written as criteria because each fails *silently* when unmet.

### PLT-01 — Identity is consistent in four places · P0
- **Given** the app is running under Wayland on KDE
- **When** I look at the task bar
- **Then** both windows show the app's own icon and name — which requires the Wayland `app_id` (from `g_get_prgname()`, which otherwise defaults to the executable name), the desktop entry filename, the entry's `Icon=` key and the installed icon filename to all agree

### PLT-02 — Global hotkey binds through the portal · P1
- **Given** a Wayland session, where no application may grab keys directly
- **When** the app registers its global hotkey (WIN-04)
- **Then** it binds through `org.freedesktop.portal.GlobalShortcuts`, having first written a desktop entry that the portal can resolve — and the settings screen reports the binding's real state, including "no key assigned", with a button opening KDE's own shortcut editor

### PLT-03 — Window placement is the compositor's to decide · P0
- **Given** a Wayland session, where a client cannot position its own windows
- **When** the app restores window geometry (WIN-07)
- **Then** size is restored, position is requested but not assumed, and the app neither reports success it did not achieve nor breaks when the compositor places windows itself

### PLT-04 — The window appears on NVIDIA · P0
- **Given** a Wayland session on the NVIDIA proprietary driver, where WebKitGTK's DMA-BUF renderer trips an explicit-sync protocol error that kills the process before any window appears
- **When** the app starts
- **Then** it sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Wayland unless already set, and both windows appear

### PLT-05 — Documented, reproducible build · P0
- **Given** a fresh clone on Arch or CachyOS
- **When** I follow the README
- **Then** one documented `pacman` line installs the system dependencies, `pnpm tauri dev` builds and runs, and the fish-specific note about `~/.cargo/env.fish` is present — because `~/.cargo/env` is bash syntax and errors under fish

### PLT-06 — Release bundles · P1
- **Given** the release build
- **When** I run it
- **Then** `deb`, `rpm` and AppImage artifacts are produced, with `NO_STRIP=1` set for the AppImage target (linuxdeploy bundles a `strip` too old for the `.relr.dyn` section current system libraries carry, which fails the whole bundle step) and `APPIMAGE_EXTRACT_AND_RUN=1` for FUSE-3-only hosts

### PLT-07 — Rust version floor is correct · P0
- **Given** `src-tauri/Cargo.toml`
- **When** dependencies resolve
- **Then** `rust-version` is at or above what every dependency requires — a floor set too low makes Cargo silently resolve Tauri 1.x instead of 2.x with no error; `cargo tree -p tauri` reports what was actually selected

### PLT-08 — No orphaned processes · P0
- **Given** the app is running workspaces with PTYs
- **When** the process exits by any route — quit, window manager close, `SIGTERM`, or crash
- **Then** no orphaned shell or child process is left running; the PTY master closing must deliver `SIGHUP` to each process group

---

## 14. Settled decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | Window model | **Two real OS windows** — Workspace and Terminal, independently placed, hotkey to raise the other |
| 2 | Terminal restore after a restart | **Tabs and working directory, fresh shells.** No scrollback persisted, no command re-run |
| 3 | Rendered-pane editing | **Editable**, not a preview. This is the differentiator over VSCodium |
| 4 | Editor modes | **Three**: source · split (both sides editable) · rich |
| 5 | File fidelity | **Never reformat what I did not edit.** Surgical block splice; untouched bytes stay byte-identical |
| 6 | Markdown style config | **None.** New content uses one fixed sensible style |
| 7 | Themes | **Built-ins plus a VSCode/VSCodium theme importer** (`.json` and `.vsix`) |
| 8 | Git scope | Status, diff, stage (files and hunks), commit, history, blame — **plus branches and worktrees**, because a project here may itself be a worktree |
| 9 | Agent signals | **Attention badge on the switcher** and **notify when a busy terminal goes quiet**, notifications switchable on and off |
| 10 | Workspace | **One directory = one workspace.** A worktree is just another workspace |
| 11 | Non-markdown files | **Editable with syntax highlighting only.** No LSP, no autocomplete |
| 12 | Per-project settings | **Central app database.** Nothing is written into your repositories |
| 13 | Ignored files in the tree | **Shown dimmed, not hidden**, as in VSCodium. All dotfiles visible; only `.git/` hidden |
| 14 | Syntax highlighting | **Markdown, HTML, JSON, TOML, YAML/YML** out of the box. Anything else opens as plain text. A grammar importer is P2 |
| 15 | HTML preview | **P2.** Render an `.html` file as a browser would, in an isolated webview beside its source |

---

## 15. Assumptions filled in

These were not asked about. Correct any that are wrong before implementation
starts — each is load-bearing for the criteria above.

1. **Clipboard folder** — default `clipboard/` at the project root, configurable per workspace (AST-04). Named for what it is rather than `assets/`, which real projects already use for their own purposes.
2. **Asset naming** — a source file keeps its name and dedupes on collision; a raw clipboard bitmap, which has no filename, is timestamped (AST-03).
3. **Asset links are relative to the note**, not to the project root, so documents render correctly on GitHub and in other markdown tools (AST-05).
4. **Shell** — `$SHELL` (fish here), started as a login shell (TERM-01).
5. **Working-directory tracking** reads `/proc/<pid>/cwd`, needing no shell integration or prompt hooks (TERM-08).
6. **Scrollback** — 10 000 lines per tab, in memory, never written to disk (TERM-06, PER-03).
7. **Quiet threshold** — 20 s default for agent notifications (AGT-03).
8. **Remotes (fetch/pull/push)** are P2. Branches without remotes is a slightly odd shape, but it was not asked for and local work is what was.
9. **External change handling** (ED-20, ED-21) was not requested but is non-negotiable for this product: an agent rewriting the file you have open is the normal case here, not an edge case.
10. **Atomic saves** — temp file plus rename, preserving mode and ownership (ED-13) — because an agent may be reading the file as you write it.
11. **`.gitignore` means three different things** in three places, deliberately: the tree *dims* ignored files (TREE-05), project search *excludes* them by default with a toggle (TREE-08), and the file watcher *never watches* them (ED-23). Dimming is about orientation, exclusion is about signal, and not watching is about inotify limits.
12. **`.git/` is the single hidden path** (TREE-05b). Everything else with a leading dot is visible. Say so if you would rather see it too.
13. **`Ctrl+Alt+Shift+C` copies the relative path**; the absolute path is context-menu only (TREE-05d). VSCodium binds these as `Ctrl+K Ctrl+Alt+C` / `Ctrl+K Ctrl+Shift+C`, so muscle memory will differ.
14. **Fenced code blocks are highlighted with the same five grammars** as files (ED-17a) — a `rust` fence inside a markdown document will be plain until the importer lands.
15. **Rust and TypeScript are not in the built-in grammar set.** You will be editing this app's own `.rs` and `.ts` files in it, unhighlighted, until ED-17d. That is a consequence of the list you gave, not an oversight — say the word and they go in.
16. **Delete goes to the trash**, never `rm` (TREE-03).
17. **Mermaid rendering** is P2, not assumed to be in the first milestone (ED-11).
18. **No terminal multiplexing of our own.** If you want splits inside a terminal, run `tmux`; TERM-02 guarantees it works.

---

## 16. Deliberately out of scope

Recording these so they are decisions rather than oversights.

- Language servers, autocomplete, diagnostics, refactoring (settled decision 11)
- A general VSCode *extension* host. Only two narrow importers are planned, both P2 and both data-only: colour themes (THM-04) and TextMate grammars (ED-17d). Neither runs extension code
- Debugging, test runners, task runners
- An extension or plugin system
- Remote or SSH workspaces
- Collaborative or multi-user editing
- Any built-in LLM integration — agents run in the terminal, as `claude` does
- Non-Linux platforms; non-KDE desktops are best-effort, since §13 is written against KDE

---

## 17. Proposed milestones

**M1 — the mechanism works.** §1 (workspaces), §2 (two windows), §3 (terminal),
§4 P0 (tree, open, quick open), §12 (persistence), §13 (platform). At the end of
M1 you can run `claude` in project X, switch to Y, come back, and X is still
running. That is the whole reason the product exists, and it is worth proving
before any editor work begins.

**M2 — the editor.** §5 (three modes, surgical splice), §6 (clipboard assets),
§7 (non-markdown, the five grammars, external change handling), §11 P0
(built-in themes).

**M3 — git and agents.** §8, §9, §10, plus §11 P1 (theme import).

**M4 — the P2 tail.** Remotes, conflict resolution, per-workspace themes,
clickable paths, mermaid, the grammar importer (ED-17d) and HTML preview
(ED-24). The two importers are worth doing together: a `.vsix` is just a zip,
and once it is being opened for grammars it is being opened for themes too.
